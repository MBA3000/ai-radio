/**
 * Permission requests (radio 1.4.0): an agent asks with "request" in the
 * agreed shape, its operator answers from the phone app with a signed
 * grant/v1, and "granted" says whether a grant holds now. Only a line the
 * radio verified with the pinned operator key counts (Solnze's condition:
 * "the chain is verified by my pinned operator key, not by text").
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findGrant, parseUntil, requestText } from "../scripts/airadio-radio.mjs";
import { answerText, parseRequest } from "../worker/app.mjs";
import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";

const RADIO = fileURLToPath(new URL("../scripts/airadio-radio.mjs", import.meta.url));
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

async function operator() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async ({ frequency, from, text, ts = Date.now() }) => {
    const payload = ["airadio-signed-v1", frequency, from, String(ts), "", text].join("\n");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload));
    return { v: 1, key, ts, sig: b64url(signature) };
  };
  return { key, sign };
}

async function eventually(check, { timeoutMs = 20_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
  return last;
}

test("a request has one shape the app reads, and only the operator's latest signed answer counts", () => {
  const now = Date.parse("2026-09-24T20:00:00Z");
  assert.equal(parseUntil("2h", now), "2026-09-24T22:00:00.000Z");
  assert.equal(parseUntil("90m", now), "2026-09-24T21:30:00.000Z");
  assert.equal(parseUntil("2026-09-25T01:00Z", now), "2026-09-25T01:00:00.000Z");
  assert.throws(() => parseUntil("2026-09-24T19:00Z", now), /in the future/u);
  assert.throws(() => parseUntil("soon", now), /in the future/u);

  const text = requestText({ id: "r-1", action: "radio.update", target: "Solnze/airadio-solnze", environment: "production", until: "2026-09-25T01:00:00.000Z", count: 1, why: "1.4.0", rollback: "bak", asker: "Solnze" });
  assert.match(text, /^REQUEST radio\.update: Solnze\/airadio-solnze \(1\.4\.0\)\n\{"airadio":"request\/v1"/u);
  const card = parseRequest(text);
  assert.equal(card.id, "r-1", "the phone app reads what the radio writes");
  assert.equal(card.count, 1);
  assert.throws(() => requestText({ id: "x", action: "rm -rf /", until: "2026-09-25T01:00:00.000Z", asker: "a" }), /dotted name/u);

  const grant = answerText(card, "grant", now);
  const deny = answerText(card, "deny", now);
  const at = (seq, from, words, operator) => ({ frequency: "fm-1", seq, from, text: words, ...(operator ? { operator: true } : {}) });
  assert.equal(findGrant([at(5, "Mallory", grant, false)], "fm-1", "r-1", now).status, "none", "a grant anyone typed is not one");
  assert.equal(findGrant([at(5, "Medet", grant, true)], "fm-1", "r-1", now).status, "granted");
  assert.equal(findGrant([at(5, "Medet", grant, true)], "fm-2", "r-1", now).status, "none", "a grant is for its own channel");
  assert.equal(findGrant([at(5, "Medet", grant, true), at(6, "Medet", deny, true)], "fm-1", "r-1", now).status, "denied", "the latest answer wins");
  assert.equal(findGrant([at(5, "Medet", grant, true)], "fm-1", "r-1", Date.parse("2026-09-25T02:00:00Z")).status, "expired");
});

test("an agent asks with request, its operator grants from the app, and granted holds only for the signed grant", { timeout: 90_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const { frequency, wave } = await (await fetch(station.url + "/v1/channel", { method: "POST" })).json();
  const medet = await operator();
  const home = mkdtempSync(join(tmpdir(), "airadio-grants-"));
  const radio = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [RADIO, ...args, "--home", home], { env: { ...process.env, AIRADIO_SYSTEMD: "0" }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
  t.after(async () => {
    await radio("stop", "--operator-asked");
    try { process.kill(Number(readFileSync(join(home, "radio.pid"), "utf8")), "SIGKILL"); } catch {}
    rmSync(home, { recursive: true, force: true });
  });
  const post = (body) => fetch(station.url + "/v1/channel/" + frequency + "/send", { method: "POST", headers: { "X-Wave": wave, "content-type": "application/json" }, body: JSON.stringify(body) });
  const heard = async () => (await (await fetch(station.url + "/v1/channel/" + frequency + "/messages?since=0", { headers: { "X-Wave": wave } })).json()).messages;

  assert.equal((await radio("tune", station.url, frequency, wave, "--as", "Solnze", "--operator", medet.key, "--operator-name", "Medet")).code, 0);
  const asked = await radio("request", frequency, "radio.update", "--until", "2h", "--target", "Solnze/airadio-solnze", "--count", "1", "--why", "radio 1.4.0", "--id", "r-t1");
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stdout, /request id r-t1: check the answer with .*granted/u);
  const request = parseRequest((await heard()).find((message) => message.text.startsWith("REQUEST")).text);
  assert.equal(request.asker, "Solnze");

  assert.equal((await radio("granted", frequency, "r-t1")).code, 5, "no answer yet");
  // Someone else types a perfect grant: it is not the operator's.
  const forged = answerText(request, "grant", Date.now());
  assert.equal((await post({ from: "Medet", text: forged })).status, 200);
  // The operator answers from the app: the same words, signed.
  assert.equal((await post({ from: "Medet", text: forged, sig: await medet.sign({ frequency, from: "Medet", text: forged }) })).status, 200);
  const granted = await eventually(async () => { const got = await radio("granted", frequency, "r-t1", "--json"); return got.code === 0 ? got : null; });
  assert.ok(granted, "the signed grant is found once the receiver has verified it");
  const report = JSON.parse(granted.stdout);
  assert.equal(report.status, "granted");
  assert.equal(report.count, 1);
  const lines = readFileSync(join(home, "inbox.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => String(entry.text).startsWith("GRANT"));
  assert.deepEqual(lines.map((entry) => entry.operator === true), [false, true], "the unsigned copy stayed untrusted");

  const first = await radio("granted", frequency, "r-t1", "--use");
  assert.equal(first.code, 0);
  assert.match(first.stdout, /^GRANTED r-t1: radio\.update on Solnze\/airadio-solnze until .*use 1 of 1/u);
  const second = await radio("granted", frequency, "r-t1", "--use");
  assert.equal(second.code, 5, "a grant for one use is spent after it");
  assert.match(second.stdout, /^SPENT r-t1/u);

  const no = answerText({ ...request, id: "r-t2" }, "deny", Date.now());
  assert.equal((await post({ from: "Medet", text: no, sig: await medet.sign({ frequency, from: "Medet", text: no }) })).status, 200);
  const denied = await eventually(async () => { const got = await radio("granted", frequency, "r-t2"); return /^DENIED/u.test(got.stdout) ? got : null; });
  assert.equal(denied.code, 5);
});
