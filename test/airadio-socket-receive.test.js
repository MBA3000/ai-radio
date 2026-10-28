// Exercise the real receiver loop without a listener, network or agent process.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalMandate, radioPaths, runReceiver } from "../scripts/airadio-radio.mjs";

const frequency = "fm-0123456789abcdef";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await wait(10);
  }
  assert.ok(check(), "receiver completed the tick");
}

async function operator() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
  const sign = async ({ from, text, mandate, ts = Date.now() }) => {
    const payload = ["airadio-signed-v1", frequency, from, String(ts), mandate ? canonicalMandate(mandate) : "", text].join("\n");
    const bytes = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload));
    return { v: 1, key, ts, sig: Buffer.from(bytes).toString("base64url"), ...(mandate ? { mandate } : {}) };
  };
  return { key, sign };
}

async function receiver(t, key) {
  const home = mkdtempSync(join(tmpdir(), "airadio-frame-"));
  const paths = radioPaths(home);
  const json = (file) => JSON.parse(readFileSync(file, "utf8"));
  const config = { channels: { [frequency]: {
    station: "https://station.test", key: "test-channel-key", as: "bot", operator: { key },
    agent: { epoch: 1, maxPerHour: 1 },
  } } };
  writeFileSync(paths.config, JSON.stringify(config));
  // A capped session retains its queue without launching an external program.
  writeFileSync(paths.state, JSON.stringify({ agents: { [frequency]: {
    epoch: 1, wakes: [Date.now()], pending: [], pausedNotice: true,
  } } }));
  let socket;
  let reads = 0;
  const rows = [];
  t.mock.method(globalThis, "WebSocket", function () {
    socket = { closed: false, close() { this.closed = true; }, send() {} };
    queueMicrotask(() => socket.onmessage({ data: '{"type":"hello","lastSeq":0}' }));
    return socket;
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = new URL(url);
    assert.equal(target.pathname, "/v1/channel/" + frequency + "/messages");
    reads += 1;
    const messages = rows.filter((row) => row.seq > Number(target.searchParams.get("since")));
    return new Response(JSON.stringify({ messages, hasMore: false }));
  });
  const running = runReceiver({ home, log: () => {} });
  t.after(async () => {
    writeFileSync(paths.config, '{"channels":{}}');
    writeFileSync(paths.poke, "stop the test receiver");
    await running;
    rmSync(home, { recursive: true, force: true });
  });
  await eventually(() => { try { return json(paths.state).delivery?.[frequency] === "socket"; } catch { return false; } });
  const state = () => json(paths.state);
  const inbox = () => {
    try { return readFileSync(paths.inbox, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
  };
  const frame = async (msg) => {
    const heartbeat = state().heartbeat;
    await wait(2);
    socket.onmessage({ data: JSON.stringify({ type: "message", msg }) });
    await eventually(() => state().heartbeat !== heartbeat);
  };
  const poll = async () => {
    const before = reads;
    writeFileSync(paths.poke, "poll");
    await eventually(() => reads > before);
  };
  return { state, inbox, frame, poll, rows, reads: () => reads, socket: () => socket,
    mandate: () => json(paths.config).channels[frequency].mandate };
}

test("three rejected frames cannot change inbox, agent queue or cursor; polling then continues", async (t) => {
  const owner = await operator();
  const radio = await receiver(t, owner.key);
  const words = { from: "owner", text: "signed words", ts: Date.now() };
  const sig = await owner.sign(words);
  const first = { seq: 1, at: new Date(words.ts).toISOString(), from: words.from, text: words.text, sig };
  radio.rows.push(first);
  const reads = radio.reads();
  await radio.frame(first);
  assert.equal(radio.reads(), reads, "a signed frame needs no REST read");
  assert.equal(radio.inbox()[0].operator, true);
  const before = radio.inbox();
  const pending = radio.state().agents[frequency].pending;
  assert.equal(pending.length, 1, "a valid frame queues an agent message");
  assert.equal(pending[0].operator, true);
  const message = { ...first, seq: 2 };
  const rejected = [
    { ...message, sig: { ...sig, sig: Buffer.alloc(64).toString("base64url") } },
    { ...message, from: "bot" }, // Even our own name must not skip verification.
    { ...message, sig: await owner.sign(words) }, // New ECDSA bytes, the same digest.
  ];
  for (const [index, msg] of rejected.entries()) {
    await radio.frame(msg);
    assert.equal(radio.state().cursors[frequency], 1);
    assert.deepEqual(radio.inbox(), before);
    assert.deepEqual(radio.state().agents[frequency].pending, pending);
    assert.equal(radio.state().delivery[frequency], index < 2 ? "socket" : "polling");
  }
  assert.equal(radio.socket().closed, true);
  radio.rows.push({ seq: 2, at: new Date().toISOString(), from: "peer", text: "still heard by polling" });
  await radio.poll();
  assert.equal(radio.state().cursors[frequency], 2);
  assert.equal(radio.inbox().at(-1).text, "still heard by polling");
  assert.equal(radio.state().agents[frequency].pending.at(-1).text, "still heard by polling");
});

test("frames reuse canonical signatures, both ten-minute bounds and signature-time mandate ordering", async (t) => {
  const owner = await operator();
  const radio = await receiver(t, owner.key);
  const ts = Date.now();
  const mandate = { until: new Date(ts + 3_600_000).toISOString(), to: "bot", scope: "talk" };
  const words = { from: "owner", text: "permission", ts, mandate };
  const sig = await owner.sign(words);
  const first = { seq: 1, at: new Date(ts).toISOString(), from: words.from, text: words.text, sig };
  radio.rows.push(first);
  const reads = radio.reads();
  await radio.frame(first);
  assert.equal(radio.reads(), reads);
  assert.equal(radio.mandate().scope, "talk");
  assert.equal(radio.mandate().signedTs, ts);

  const reject = async (msg) => {
    const before = radio.inbox();
    const cursor = radio.state().cursors[frequency];
    const pending = radio.state().agents[frequency].pending;
    await radio.frame({ ...msg, seq: cursor + 1 });
    assert.equal(radio.state().cursors[frequency], cursor);
    assert.deepEqual(radio.inbox(), before);
    assert.deepEqual(radio.state().agents[frequency].pending, pending);
    assert.equal(radio.mandate().scope, "talk");
  };
  for (const delta of [-600_001, 600_001]) {
    const text = "outside the signature window " + delta;
    await reject({ ...first, text, at: new Date(ts + delta).toISOString(), sig: await owner.sign({ ...words, text }) });
  }
  assert.equal(radio.state().delivery[frequency], "socket");
  const older = { ...words, text: "older permission", ts: ts - 1_000, mandate: { ...mandate, scope: "tools" } };
  const old = { ...first, seq: 2, text: older.text, sig: await owner.sign(older) };
  radio.rows.push(old);
  const readsBefore = radio.reads();
  await radio.frame(old);
  assert.equal(radio.reads(), readsBefore);
  assert.equal(radio.inbox().find((entry) => entry.seq === 2).operator, true);
  assert.equal(radio.mandate().scope, "talk", "a later seq cannot override a newer signature's mandate");
  assert.equal(radio.mandate().signedTs, ts);
  await reject({ ...first, sig: { ...sig, mandate: { ...mandate, scope: "tools" } } });
  await reject({ ...first, text: "tampered words", operator: true });
  assert.equal(radio.state().delivery[frequency], "socket", "a valid frame resets the consecutive rejection count");
});

test("seq-only frames use REST, share its replay ledger, and gaps never skip messages", async (t) => {
  const owner = await operator();
  const radio = await receiver(t, owner.key);
  const words = { from: "owner", text: "read over REST", ts: Date.now() };
  const first = { seq: 1, at: new Date(words.ts).toISOString(), from: words.from, text: words.text, sig: await owner.sign(words) };
  radio.rows.push(first);
  const reads = radio.reads();
  await radio.frame({ seq: 1 });
  assert.equal(radio.reads(), reads + 1);
  assert.equal(radio.inbox()[0].operator, true);
  await radio.frame({ ...first, seq: 2, sig: await owner.sign(words) });
  assert.equal(radio.state().cursors[frequency], 1, "a socket cannot replay signed words already heard over REST");
  assert.equal(radio.inbox().length, 1);

  const missed = { seq: 2, at: first.at, from: "peer", text: "missed frame" };
  const later = { ...missed, seq: 3, text: "after the gap" };
  radio.rows.push(missed, later);
  const beforeGap = radio.reads();
  await radio.frame(later);
  assert.equal(radio.reads(), beforeGap + 1);
  assert.deepEqual(radio.inbox().map((entry) => entry.seq), [1, 2, 3]);
  const beforeLive = radio.reads();
  // A consumed seq is ignored even if a later frame changes the body.
  radio.socket().onmessage({ data: JSON.stringify({ type: "message", msg: { ...later, text: "conflicting body" } }) });
  await radio.frame({ ...later, seq: 4, text: "unsigned frame", operator: true });
  assert.equal(radio.reads(), beforeLive);
  assert.equal(radio.inbox().at(-1).untrusted, true, "a frame cannot supply operator authority");
  assert.deepEqual(radio.inbox().map((entry) => entry.text), [words.text, missed.text, later.text, "unsigned frame"]);
});
