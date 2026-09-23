import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";

const jsonRequest = async (url, options = {}) => {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
};

test("the local station runs the production Worker and SQLite-backed AiRadioChannel for an authenticated conversation", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());

  const created = await jsonRequest(`${station.url}/v1/channel`, { method: "POST" });
  assert.equal(created.response.status, 200);
  assert.match(created.body.frequency, /^fm-[a-f0-9]{16}$/u);
  assert.match(created.body.wave, /^[a-f0-9]{128}$/u);

  const sent = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Wave": created.body.wave },
    body: JSON.stringify({ from: "alpha", text: "local-production-worker-proof" }),
  });
  assert.equal(sent.response.status, 200);
  assert.equal(sent.body.seq, 1);

  station.restart(created.body.frequency);
  const received = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/messages?since=0`, {
    headers: { "X-Wave": created.body.wave },
  });
  assert.equal(received.response.status, 200);
  assert.deepEqual(received.body.messages, [
    { seq: 1, at: received.body.messages[0].at, from: "alpha", text: "local-production-worker-proof" },
  ]);
  assert.equal(received.body.last, 1);
});

test("a raw wrong-wave REST read or send is refused without appending a message", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());

  const created = await jsonRequest(`${station.url}/v1/channel`, { method: "POST" });
  assert.equal(created.response.status, 200);

  const refusedSend = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Wave": "wrong-wave" },
    body: JSON.stringify({ from: "intruder", text: "must-not-append" }),
  });
  assert.equal(refusedSend.response.status, 403);

  const refusedRead = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/messages?since=0`, {
    headers: { "X-Wave": "wrong-wave" },
  });
  assert.equal(refusedRead.response.status, 403);

  const authenticatedRead = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/messages?since=0`, {
    headers: { "X-Wave": created.body.wave },
  });
  assert.equal(authenticatedRead.response.status, 200);
  assert.deepEqual(authenticatedRead.body.messages, []);
  assert.equal(authenticatedRead.body.last, 0);
});

test("the production mailbox is protected, records a call, and updates public presence on an authenticated read", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());

  const beta = await jsonRequest(`${station.url}/v1/station`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callsign: "beta" }),
  });
  const channel = await jsonRequest(`${station.url}/v1/channel`, { method: "POST" });
  assert.equal(beta.response.status, 200);
  assert.equal(channel.response.status, 200);

  const called = await jsonRequest(`${station.url}/v1/station/beta/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "alpha",
      text: JSON.stringify({ type: "call", frequency: channel.body.frequency, key: channel.body.wave, note: "local proof" }),
    }),
  });
  assert.equal(called.response.status, 200);
  assert.equal(called.body.seq, 1);

  const refused = await jsonRequest(`${station.url}/v1/station/beta/calls?since=0`, { headers: { "X-Wave": "wrong-key" } });
  assert.equal(refused.response.status, 403);

  const mailbox = await jsonRequest(`${station.url}/v1/station/beta/calls?since=0`, { headers: { "X-Wave": beta.body.key } });
  assert.equal(mailbox.response.status, 200);
  assert.equal(mailbox.body.messages.length, 1);
  assert.equal(mailbox.body.messages[0].seq, 1);
  assert.equal(mailbox.body.messages[0].from, "alpha");
  assert.equal(JSON.parse(mailbox.body.messages[0].text).frequency, channel.body.frequency);

  const presence = await jsonRequest(`${station.url}/v1/station/beta`);
  assert.equal(presence.response.status, 200);
  assert.equal(presence.body.registered, true);
  assert.equal(presence.body.onAir, true);
});

test("the production relay retains the newest 1000 messages and preserves ascending cursors through pages", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());

  const created = await jsonRequest(`${station.url}/v1/channel`, { method: "POST" });
  assert.equal(created.response.status, 200);

  for (let index = 1; index <= 1001; index += 1) {
    const sent = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Wave": created.body.wave },
      body: JSON.stringify({ from: "alpha", text: `retention-${index}` }),
    });
    assert.equal(sent.response.status, 200);
    assert.equal(sent.body.seq, index);
  }

  const firstPage = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/messages?since=0`, {
    headers: { "X-Wave": created.body.wave },
  });
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.messages.length, 200);
  assert.equal(firstPage.body.messages[0].seq, 2, "the oldest record is pruned, not its cursor successor");
  assert.equal(firstPage.body.messages.at(-1).seq, 201);
  assert.equal(firstPage.body.last, 201);

  const finalPage = await jsonRequest(`${station.url}/v1/channel/${created.body.frequency}/messages?since=801`, {
    headers: { "X-Wave": created.body.wave },
  });
  assert.equal(finalPage.response.status, 200);
  assert.equal(finalPage.body.messages.length, 200);
  assert.equal(finalPage.body.messages[0].seq, 802);
  assert.equal(finalPage.body.messages.at(-1).seq, 1001);
  assert.equal(finalPage.body.last, 1001);
});

test("the Airadio MCP probe refuses a default public or mutating mode", () => {
  const probe = fileURLToPath(new URL("../scripts/airadio-mcp-probe.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--local-selftest/u);
});

test("the local production Worker enforces the injected limiter while static GETs stay open", async (t) => {
  const calls = [];
  const station = await startAiradioLocalStation({
    limiter: { limit: async ({ key }) => { calls.push(key); return { success: false }; } },
  });
  t.after(() => station.close());
  for (const path of ["/", "/health", "/daemon.mjs"]) {
    const response = await fetch(station.url + path);
    assert.equal(response.status, 200, `${path} must be ungated`);
  }
  for (const [path, body] of [
    ["/v1/channel", undefined],
    ["/v1/station", { callsign: "limited-station" }],
    ["/v1/station/limited-station/call", { from: "caller", text: "hello" }],
  ]) {
    const response = await fetch(station.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.80" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
  }
  assert.deepEqual(calls, ["192.0.2.80", "192.0.2.80", "192.0.2.80"]);
});

test("the canary probe exercises only a disposable local channel end to end", async (t) => {
  const station = await startAiradioLocalStation({ gitSha: "canary-test-sha" });
  t.after(() => station.close());
  const probe = fileURLToPath(new URL("../scripts/airadio-mcp-probe.mjs", import.meta.url));
  const child = spawn(process.execPath, [
    probe,
    "--canary",
    "--preview-url",
    station.url,
    "--channel-only",
    "--allow-local-http",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /channel canary passed/u);
  assert.doesNotMatch(stdout + stderr, /[a-f0-9]{128}/u, "the one-time wave must not reach probe output");
  const source = readFileSync(probe, "utf8");
  assert.doesNotMatch(source, /\/v1\/station/u, "the preview canary has no station or mailbox code path");
});
