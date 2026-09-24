/**
 * Live delivery (radio 1.3.0): a receiver keeps a WebSocket per channel and
 * the channel pushes each new message down it, so a quiet channel costs no
 * requests and a message arrives at once. The design, and the review that
 * shaped it, is docs/design/ws-hibernation.md. The station side runs the
 * real Worker and channel against the local station's minimal WebSocket
 * server, which stands in for the Hibernation API.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { socketDelay, socketUrl } from "../scripts/airadio-radio.mjs";
import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";

const RADIO = fileURLToPath(new URL("../scripts/airadio-radio.mjs", import.meta.url));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function eventually(check, { timeoutMs = 20_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await wait(everyMs);
  }
  return last;
}

async function openChannel(station) {
  const response = await fetch(station.url + "/v1/channel", { method: "POST" });
  assert.equal(response.status, 200);
  const { frequency, wave } = await response.json();
  const say = async (from, text) => (await fetch(station.url + "/v1/channel/" + frequency + "/send", {
    method: "POST",
    headers: { "X-Wave": wave, "content-type": "application/json" },
    body: JSON.stringify({ from, text }),
  })).json();
  const read = async () => (await (await fetch(station.url + "/v1/channel/" + frequency + "/messages?since=0", { headers: { "X-Wave": wave } })).json()).messages;
  const presence = async () => (await (await fetch(station.url + "/v1/channel/" + frequency + "/presence", { headers: { "X-Wave": wave } })).json()).listeners;
  return { frequency, wave, say, read, presence };
}

/** A socket client that records every frame and how it ended. */
function connect(station, channel, { key = channel.wave, name = null } = {}) {
  const frames = [];
  const ws = new WebSocket(socketUrl(station.url, channel.frequency), { headers: { "X-Wave": key, ...(name ? { "X-Callsign": name } : {}) } });
  const opened = new Promise((ok) => {
    ws.onopen = () => ok(true);
    ws.onclose = () => ok(false);
    ws.onerror = () => ok(false);
  });
  const closed = new Promise((ok) => ws.addEventListener("close", (event) => ok(event.code)));
  ws.onmessage = (event) => frames.push(String(event.data));
  const json = () => frames.filter((frame) => frame.startsWith("{")).map((frame) => JSON.parse(frame));
  return { ws, frames, json, opened, closed };
}

/** A raw upgrade, to see the HTTP status a refused socket gets. */
function upgradeStatus(station, frequency, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(station.url + "/v1/channel/" + frequency + "/ws");
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...headers },
    });
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

function sandbox(t, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "airadio-socket-"));
  const radio = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [RADIO, ...args, "--home", home], { env: { ...process.env, AIRADIO_SYSTEMD: "0", ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
  const inbox = () => {
    try {
      return readFileSync(join(home, "inbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const delivery = async () => JSON.parse((await radio("status", "--json", "--offline")).stdout).channels[0].delivery;
  t.after(async () => {
    await radio("stop", "--operator-asked");
    try {
      const pid = Number(readFileSync(join(home, "radio.pid"), "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });
  return { home, radio, inbox, delivery };
}

test("socket addresses and the reconnect schedule", () => {
  assert.equal(socketUrl("https://airadio.akbrd.com", "fm-0123456789abcdef"), "wss://airadio.akbrd.com/v1/channel/fm-0123456789abcdef/ws");
  assert.equal(socketUrl("http://127.0.0.1:8787/", "fm-0123456789abcdef"), "ws://127.0.0.1:8787/v1/channel/fm-0123456789abcdef/ws");
  const middle = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4].map((failures) => socketDelay(failures, middle)), [1_000, 2_000, 4_000, 300_000, 300_000],
    "1 s doubling, then after three failures in a row the channel is polled and the socket tried every 5 minutes");
  assert.equal(socketDelay(0, () => 0), 750, "jitter reaches 25% below");
  assert.equal(socketDelay(0, () => 0.999_999), 1_250, "and 25% above");
});

test("the station refuses a socket without the right key, and says hello with the newest seq to one that has it", { timeout: 30_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const channel = await openChannel(station);
  await channel.say("host", "one");
  await channel.say("host", "two");

  assert.equal(await upgradeStatus(station, channel.frequency, { "X-Wave": "wrong" }), 403);
  assert.equal(await upgradeStatus(station, channel.frequency, {}), 403, "no key, no socket");
  assert.equal(await upgradeStatus(station, "fm-00000000deadbeef", { "X-Wave": channel.wave }), 404);
  const plain = await fetch(station.url + "/v1/channel/" + channel.frequency + "/ws", { headers: { "X-Wave": channel.wave } });
  assert.equal(plain.status, 426, "a plain GET is told it is a WebSocket");
  assert.equal(station.sockets(channel.frequency).length, 0);

  const client = connect(station, channel);
  assert.equal(await client.opened, true);
  await eventually(() => client.frames.length > 0);
  assert.deepEqual(client.json()[0], { type: "hello", lastSeq: 2 }, "the first frame tells a reconnecting receiver whether it missed anything");
  client.ws.close();
  assert.equal(await client.closed, 1005);
  await eventually(() => station.sockets(channel.frequency).length === 0);
  assert.equal(station.sockets(channel.frequency).length, 0, "a closed socket leaves the channel");
});

test("a message sent by REST reaches every socket once, as a receive returns it, also after the channel hibernated", { timeout: 30_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const channel = await openChannel(station);
  const first = connect(station, channel);
  const second = connect(station, channel);
  assert.equal(await first.opened, true);
  assert.equal(await second.opened, true);
  await eventually(() => first.frames.length > 0 && second.frames.length > 0);

  const sent = await channel.say("host", "hello, both of you");
  await eventually(() => first.json().length === 2 && second.json().length === 2);
  const [row] = await channel.read();
  for (const client of [first, second]) {
    const messages = client.json().filter((frame) => frame.type === "message");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].msg, row, "the frame is the row a receive returns");
    assert.equal(messages[0].msg.seq, sent.seq);
  }

  // Hibernation rebuilds the object; the sockets are the runtime's, not the object's.
  station.hibernate(channel.frequency);
  await channel.say("host", "still here after a nap");
  await eventually(() => first.json().length === 3 && second.json().length === 3);
  assert.equal(first.json()[2].msg.text, "still here after a nap");
  assert.equal(second.json()[2].msg.text, "still here after a nap");
  first.ws.close();
  second.ws.close();
});

test("a socket that pings is on the air without reading; one that stopped pinging is closed and drops off", { timeout: 30_000 }, async (t) => {
  let offset = 0;
  const station = await startAiradioLocalStation({ clock: () => Date.now() + offset });
  t.after(() => station.close());
  const channel = await openChannel(station);

  const quiet = connect(station, channel, { name: "quiet-bot" });
  const pinging = connect(station, channel, { name: "pinging-bot" });
  assert.equal(await quiet.opened, true);
  assert.equal(await pinging.opened, true);
  const onAir = async () => Object.fromEntries((await channel.presence()).map((listener) => [listener.name, listener.onAir]));
  assert.deepEqual(await onAir(), { "quiet-bot": true, "pinging-bot": true }, "a socket puts its name on the listener list without a single read");

  for (const step of [60, 60]) {
    offset += step * 1000;
    const before = pinging.frames.length;
    pinging.ws.send("ping");
    await eventually(() => pinging.frames.length > before);
    assert.equal(pinging.frames.at(-1), "pong", "the station answers ping itself");
  }
  const now = await onAir();
  assert.equal(now["pinging-bot"], true, "120 s after connecting, its pings keep it on the air");
  assert.equal(now["quiet-bot"], false, "no ping for 120 s: gone, whatever TCP says");
  assert.equal(await quiet.closed, 4000, "the station closes a socket whose receiver stopped pinging");
  assert.equal(station.sockets(channel.frequency).length, 1);
  pinging.ws.close();
});

test("a channel takes 32 sockets; the 33rd is refused and its receiver polls", { timeout: 30_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const channel = await openChannel(station);
  const clients = [];
  for (let index = 0; index < 32; index += 1) clients.push(connect(station, channel));
  assert.deepEqual(await Promise.all(clients.map((client) => client.opened)), new Array(32).fill(true));
  assert.equal(await upgradeStatus(station, channel.frequency, { "X-Wave": channel.wave }), 429);
  clients[0].ws.close();
  await eventually(() => station.sockets(channel.frequency).length === 31);
  const next = connect(station, channel);
  assert.equal(await next.opened, true, "a freed place is taken again");
  for (const client of [...clients, next]) client.ws.close();
});

test("the idle purge spares a channel someone listens to on a live socket", { timeout: 30_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const listened = await openChannel(station);
  const idle = await openChannel(station);
  const client = connect(station, listened);
  assert.equal(await client.opened, true);
  await station.alarm(listened.frequency);
  await station.alarm(idle.frequency);
  assert.equal((await fetch(station.url + "/v1/channel/" + listened.frequency + "/messages?since=0", { headers: { "X-Wave": listened.wave } })).status, 200);
  assert.equal((await fetch(station.url + "/v1/channel/" + idle.frequency + "/messages?since=0", { headers: { "X-Wave": idle.wave } })).status, 404);
  client.ws.close();
});

test("a receiver on a live socket stops polling, and a message arrives at once with one read", { timeout: 60_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const channel = await openChannel(station);
  await channel.say("host", "welcome");
  const { radio, inbox, delivery } = sandbox(t);
  assert.equal((await radio("tune", station.url, channel.frequency, channel.wave, "--as", "bot")).code, 0);
  assert.equal(await eventually(async () => (await delivery()) === "socket"), true, "the receiver says it is on a live socket");
  assert.match((await radio("status", "--offline")).stdout, /; live socket/u);

  const quietFrom = station.reads(channel.frequency);
  await wait(6_500);
  assert.equal(station.reads(channel.frequency), quietFrom, "no reads while nothing happens (polling would read every 5 s)");

  const started = Date.now();
  await channel.say("host", "over the socket");
  const heard = await eventually(() => inbox().find((entry) => entry.text === "over the socket"));
  assert.ok(heard, "the message reached the inbox");
  assert.ok(Date.now() - started < 3_000, "at once, not at the next poll: " + (Date.now() - started) + " ms");
  assert.equal(station.reads(channel.frequency), quietFrom + 1, "one message, one read");

  // A deploy drops every socket; what was said meanwhile is read on reconnect.
  station.restart(channel.frequency);
  await channel.say("host", "said during the outage");
  await channel.say("host", "and once more");
  assert.ok(await eventually(() => inbox().some((entry) => entry.text === "and once more")), "the reconnect caught up");
  assert.equal(await eventually(async () => (await delivery()) === "socket" && station.sockets(channel.frequency).length === 1), true);
  const seqs = inbox().filter((entry) => Number.isSafeInteger(entry.seq)).map((entry) => entry.seq);
  assert.equal(new Set(seqs).size, seqs.length, "nothing heard twice");
});

test("without live delivery at the station, or with AIRADIO_SOCKETS=0, the receiver polls as before", { timeout: 60_000 }, async (t) => {
  const old = await startAiradioLocalStation({ webSockets: false });
  t.after(() => old.close());
  const channel = await openChannel(old);
  const { radio, inbox, delivery } = sandbox(t);
  assert.equal((await radio("tune", old.url, channel.frequency, channel.wave, "--as", "bot")).code, 0);
  await channel.say("host", "heard by polling");
  assert.ok(await eventually(() => inbox().some((entry) => entry.text === "heard by polling")), "a station without sockets is polled");
  assert.equal(await delivery(), "polling");
  assert.match((await radio("status", "--offline")).stdout, /; polling/u);

  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const other = await openChannel(station);
  const off = sandbox(t, { AIRADIO_SOCKETS: "0" });
  assert.equal((await off.radio("tune", station.url, other.frequency, other.wave, "--as", "bot")).code, 0);
  await other.say("host", "polled on purpose");
  assert.ok(await eventually(() => off.inbox().some((entry) => entry.text === "polled on purpose")));
  assert.equal(station.sockets(other.frequency).length, 0, "AIRADIO_SOCKETS=0 opens no socket");
  assert.equal(await off.delivery(), "polling");
});

test("a browser trades its key for a ticket: one socket, within 10 s, and only the ticket's hash is kept", { timeout: 30_000 }, async (t) => {
  let offset = 0;
  const station = await startAiradioLocalStation({ clock: () => Date.now() + offset });
  t.after(() => station.close());
  const channel = await openChannel(station);
  const ticket = async (key = channel.wave, name) => {
    const response = await fetch(station.url + "/v1/channel/" + channel.frequency + "/ws-ticket", {
      method: "POST", headers: { "X-Wave": key, "content-type": "application/json" }, body: JSON.stringify(name ? { name } : {}),
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  };
  assert.equal((await ticket("wrong")).status, 403, "no key, no ticket");
  const good = await ticket(channel.wave, "Medet");
  assert.equal(good.status, 200);
  assert.match(good.body.ticket, /^[a-f0-9]{32}$/u);
  assert.equal(good.body.expiresIn, 10);
  assert.equal(good.cache, "no-store");

  const open = (value) => {
    const ws = new WebSocket(socketUrl(station.url, channel.frequency) + "?ticket=" + value);
    const frames = [];
    ws.onmessage = (event) => frames.push(String(event.data));
    // Node 22 reports a refused handshake with "error" alone.
    return { ws, frames, opened: new Promise((ok) => { ws.onopen = () => ok(true); ws.onclose = () => ok(false); ws.onerror = () => ok(false); }) };
  };
  const first = open(good.body.ticket);
  assert.equal(await first.opened, true, "a fresh ticket opens a socket");
  assert.equal((await channel.presence()).find((listener) => listener.name === "Medet")?.onAir, true, "the ticket carries the listener's name");
  assert.equal(await open(good.body.ticket).opened, false, "a ticket opens one socket only");
  assert.equal(await open("0".repeat(32)).opened, false, "an unknown ticket opens nothing");
  assert.equal(await upgradeStatus(station, channel.frequency, {}), 403, "no key and no ticket");

  const stale = await ticket();
  offset += 11_000;
  assert.equal(await open(stale.body.ticket).opened, false, "a ticket older than 10 s is refused");
  first.ws.close();
});
