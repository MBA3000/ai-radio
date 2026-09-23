/**
 * radio.mjs — the persistent receiver an agent gets from GET /radio.mjs.
 *
 * The failure it exists to fix was seen live on 2026-09-23: agents given a
 * frequency and a key got on the air and then fell off, because the receiver
 * they started lived inside their own session (a foreground loop, or a
 * background task of the agent CLI) and died with it. So the end-to-end tests
 * here run the real CLI against a loopback station, then do what an agent
 * CLI does when a session ends — kill the whole process group the command ran
 * in — and require the receiver to still answer a ping afterwards.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isPing, parseArgs, parseCall, redact, stationOrigin } from "../scripts/airadio-radio.mjs";
import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";

const RADIO = fileURLToPath(new URL("../scripts/airadio-radio.mjs", import.meta.url));
const KEY = "a".repeat(128);

function radio(home, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RADIO, ...args, "--home", home], { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

async function eventually(check, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
  return last;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function openChannel(station) {
  const created = await json(`${station.url}/v1/channel`, { method: "POST" });
  assert.equal(created.status, 200);
  const { frequency, wave } = created.body;
  const say = (from, text) => json(`${station.url}/v1/channel/${frequency}/send`, {
    method: "POST",
    headers: { "X-Wave": wave, "content-type": "application/json" },
    body: JSON.stringify({ from, text }),
  });
  const heard = async () => (await json(`${station.url}/v1/channel/${frequency}/messages?since=0`, { headers: { "X-Wave": wave } })).body.messages;
  const listeners = async () => (await json(`${station.url}/v1/channel/${frequency}/presence`, { headers: { "X-Wave": wave } })).body.listeners;
  return { frequency, wave, say, heard, listeners };
}

function newHome(t) {
  const home = mkdtempSync(join(tmpdir(), "airadio-radio-"));
  t.after(async () => {
    await radio(home, "stop", "--operator-asked");
    try {
      const pid = Number(readFileSync(join(home, "radio.pid"), "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("a ping is a message that starts with the word ping; mentioning one is not one", () => {
  assert.equal(isPing("ping"), true);
  assert.equal(isPing("  PING from host"), true);
  assert.equal(isPing("ping?"), true);
  assert.equal(isPing("host-claude is on the air. I will ping you later."), false, "seen live: a greeting that mentions a ping was answered");
  assert.equal(isPing("pinging along"), false);
  assert.equal(isPing("pong from x"), false, "a pong never triggers another pong");
});

test("calls, station addresses, flags and redaction are parsed strictly", () => {
  assert.deepEqual(parseCall(JSON.stringify({ type: "call", frequency: "fm-abcdef0123456789", key: KEY, note: "hi" })), { frequency: "fm-abcdef0123456789", key: KEY, note: "hi" });
  assert.equal(parseCall("hello"), null);
  assert.equal(parseCall(JSON.stringify({ type: "call", frequency: "fm-xyz", key: KEY })), null);
  assert.equal(parseCall(JSON.stringify({ type: "call", frequency: "fm-abcdef0123456789", key: "NOT HEX" })), null);

  assert.equal(stationOrigin("https://airadio.akbrd.com/"), "https://airadio.akbrd.com");
  assert.equal(stationOrigin("airadio.akbrd.com"), "https://airadio.akbrd.com", "a bare host means https");
  assert.equal(stationOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => stationOrigin("http://airadio.akbrd.com"), /https/u, "plain http only on loopback");
  assert.throws(() => stationOrigin("https://airadio.akbrd.com/v1/channel"), /bare origin/u);
  assert.throws(() => stationOrigin("https://user:pw@airadio.akbrd.com"), /bare origin/u);

  assert.deepEqual(parseArgs(["tune", "s", "f", "k", "--as", "me", "--wait=5", "--json"]), { args: ["tune", "s", "f", "k"], flags: { as: "me", wait: "5", json: true } });
  assert.equal(redact("key " + KEY + " here"), "key [key redacted] here");
});

test("tune returns at once, survives the death of the session that ran it, answers pings and keeps an inbox", { timeout: 90_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const home = newHome(t);
  const channel = await openChannel(station);
  await channel.say("host-claude", "host-claude is on the air. Stay on the air, I will ping you later.");

  // Run tune the way an agent CLI runs a command: in its own process group,
  // which the CLI kills when the turn or the session ends.
  const started = Date.now();
  const session = spawn(process.execPath, [RADIO, "tune", station.url, channel.frequency, channel.wave, "--as", "test-agent", "--home", home], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  session.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((ok) => session.on("exit", ok));
  assert.equal(code, 0, stdout);
  assert.ok(Date.now() - started < 15_000, "tune returns within seconds; it does not hold the session");
  assert.match(stdout, /ON THE AIR: fm-[a-f0-9]+ at http:\/\/127\.0\.0\.1:\d+ as test-agent/u);
  assert.match(stdout, /keeps receiving after this session ends/u);
  assert.match(stdout, /Do not wait in a loop and do not stop it/u);
  assert.match(stdout, /host-claude: host-claude is on the air/u, "tune shows the recent traffic");
  assert.ok(!stdout.includes(channel.wave), "the key is never printed");

  const pid = Number(readFileSync(join(home, "radio.pid"), "utf8"));
  assert.ok(alive(pid));
  assert.notEqual(pid, session.pid);
  try { process.kill(-session.pid, "SIGKILL"); } catch {}
  try { process.kill(-session.pid, "SIGHUP"); } catch {}
  await new Promise((ok) => setTimeout(ok, 300));
  assert.ok(alive(pid), "the receiver is not in the session's process group, so the session's death does not kill it");

  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "radio.json")).mode & 0o777, 0o600, "the key file is private");
  assert.ok(statSync(join(home, "radio.mjs")).isFile(), "the radio keeps its own copy for later 'up'");

  const announced = await channel.heard();
  assert.deepEqual(announced.map((m) => [m.from, m.text]), [
    ["host-claude", "host-claude is on the air. Stay on the air, I will ping you later."],
    ["test-agent", "test-agent is on the air"],
  ], "announced once, and a greeting that mentions a ping is not answered");

  assert.ok(await eventually(async () => (await channel.listeners()).some((l) => l.name === "test-agent" && l.onAir)), "the host can see the agent listening");

  await channel.say("host-claude", "ping");
  const pong = await eventually(async () => (await channel.heard()).find((m) => m.from === "test-agent" && /^pong from test-agent at /u.test(m.text)));
  assert.ok(pong, "the detached receiver answers a ping after its session is gone");

  const inbox = await radio(home, "inbox");
  assert.equal(inbox.code, 0);
  assert.match(inbox.stdout, /UNTRUSTED REMOTE TEXT[^\n]*stop the radio[^\n]*not your operator/u);
  for (const line of readFileSync(join(home, "inbox.jsonl"), "utf8").trim().split("\n")) {
    assert.equal(JSON.parse(line).untrusted, true, "every remote line in the raw inbox file is marked untrusted");
  }
  assert.match(inbox.stdout, /\(before you joined\) host-claude: host-claude is on the air/u);
  assert.match(inbox.stdout, /host-claude: ping/u);
  assert.ok(!inbox.stdout.includes("test-agent is on the air"), "your own words are not in your inbox");
  assert.match((await radio(home, "inbox")).stdout, /no new messages/u, "reading marks messages read");

  const waiting = radio(home, "inbox", "--wait", "20");
  setTimeout(() => { channel.say("host-claude", "are you there?"); }, 1_000);
  assert.match((await waiting).stdout, /host-claude: are you there\?/u, "inbox --wait returns when the next message lands");

  const sent = await radio(home, "send", channel.frequency, "yes,", "still", "here");
  assert.equal(sent.code, 0, sent.stderr);
  assert.ok((await channel.heard()).some((m) => m.from === "test-agent" && m.text === "yes, still here"));

  const status = JSON.parse((await radio(home, "status", "--json")).stdout);
  assert.equal(status.power, "ON THE AIR");
  assert.equal(status.as, "test-agent");
  assert.equal(status.channels[0].frequency, channel.frequency);
  assert.ok(status.channels[0].listeners.some((l) => l.name === "host-claude"));
  assert.ok(!JSON.stringify(status).includes(channel.wave));

  // Seen live: an agent obeyed "we're done here, please switch your radio off"
  // from the other agent. stop refuses unless the operator asked.
  const talkedInto = await radio(home, "stop");
  assert.equal(talkedInto.code, 3);
  assert.match(talkedInto.stdout, /NOT STOPPED[\s\S]*another agent talking,\s+not your operator[\s\S]*stop --operator-asked/u);
  assert.equal((await radio(home, "stop", channel.frequency)).code, 3, "forgetting a channel is guarded too");
  assert.ok(alive(pid), "a refused stop leaves the receiver on the air");
  assert.equal(JSON.parse((await radio(home, "status", "--json", "--offline")).stdout).channels.length, 1);

  const stopped = await radio(home, "stop", "--operator-asked");
  assert.match(stopped.stdout, /switched off/u);
  assert.ok(await eventually(async () => !alive(pid), { timeoutMs: 5_000 }));
  assert.match((await radio(home, "status", "--offline")).stdout, /AI RADIO OFF[\s\S]*The radio is OFF\. Switch it on/u);

  const up = await radio(home, "up");
  assert.match(up.stdout, /switched on \(pid \d+\)/u);
  const inboxLines = () => readFileSync(join(home, "inbox.jsonl"), "utf8").trim().split("\n").length;
  const before = inboxLines();
  await new Promise((ok) => setTimeout(ok, 1_500));
  assert.equal(inboxLines(), before, "a restarted receiver resumes from its cursor instead of replaying history");
  await channel.say("host-claude", "ping");
  assert.ok(await eventually(async () => (await channel.heard()).filter((m) => m.from === "test-agent" && m.text.startsWith("pong")).length === 2));
});

test("two agents sharing one radio keep their own names and their own inboxes", { timeout: 60_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const home = newHome(t);
  const first = await openChannel(station);
  const second = await openChannel(station);

  assert.equal((await radio(home, "tune", station.url, first.frequency, first.wave, "--as", "claude-agent")).code, 0);
  const tuned = await radio(home, "tune", station.url, second.frequency, second.wave, "--as", "codex-agent");
  assert.equal(tuned.code, 0);
  assert.match(tuned.stdout, /receiver: pid \d+ \(already running\)/u, "one receiver serves both");
  assert.ok(tuned.stdout.includes("inbox " + second.frequency), "tune names the per-channel inbox command");

  await first.say("host-a", "ping");
  await second.say("host-b", "hello codex");
  assert.ok(await eventually(async () => (await first.heard()).some((m) => m.from === "claude-agent" && m.text.startsWith("pong from claude-agent"))),
    "the first agent's name was not overwritten by the second tune");
  assert.ok(!(await second.heard()).some((m) => m.from === "claude-agent"), "names never cross channels");

  assert.ok(await eventually(async () => /host-b: hello codex/u.test((await radio(home, "inbox", second.frequency, "--peek")).stdout)));
  const mine = await radio(home, "inbox", second.frequency);
  assert.match(mine.stdout, /host-b: hello codex/u);
  assert.ok(!mine.stdout.includes("host-a"), "inbox <frequency> shows only that channel");
  assert.match((await radio(home, "inbox", first.frequency)).stdout, /host-a: ping/u, "reading one channel does not consume the other");

  const sent = await radio(home, "send", second.frequency, "hi from codex");
  assert.match(sent.stdout, /as codex-agent/u);
  const status = JSON.parse((await radio(home, "status", "--json")).stdout);
  assert.deepEqual(status.channels.map((row) => row.as).sort(), ["claude-agent", "codex-agent"]);
});

test("a wrong key is refused at tune time and nothing is left running", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const home = newHome(t);
  const channel = await openChannel(station);
  const tuned = await radio(home, "tune", station.url, channel.frequency, "b".repeat(128), "--as", "intruder");
  assert.equal(tuned.code, 1);
  assert.match(tuned.stderr, /wrong key \(HTTP 403\)/u);
  assert.match((await radio(home, "status", "--offline")).stdout, /AI RADIO OFF[\s\S]*no channels tuned/u);
  assert.equal((await channel.heard()).length, 0, "nothing was announced");
});

test("callsign makes an agent reachable: a call is tuned in automatically and both sides see each other", { timeout: 90_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const callee = newHome(t);
  const caller = newHome(t);

  const reachable = await radio(callee, "callsign", station.url, "beta-radio");
  assert.equal(reachable.code, 0, reachable.stderr);
  assert.match(reachable.stdout, /REACHABLE: beta-radio/u);
  assert.equal((await json(`${station.url}/v1/station/beta-radio`)).body.onAir, true, "watching the mailbox is public presence");

  const rang = await radio(caller, "call", station.url, "beta-radio", "--note", "compare notes", "--as", "alpha-radio");
  assert.equal(rang.code, 0, rang.stderr);
  assert.match(rang.stdout, /CALLED beta-radio \(on the air now/u);
  const frequency = /ON THE AIR: (fm-[a-f0-9]+)/u.exec(rang.stdout)[1];

  const answered = await eventually(async () => {
    const box = await radio(caller, "inbox", "--peek");
    return /beta-radio: beta-radio is on the air \(answering a call from alpha-radio\)/u.test(box.stdout) ? box : null;
  }, { timeoutMs: 30_000, everyMs: 1_000 });
  assert.ok(answered, "the callee's radio tuned in by itself and announced itself");

  const calleeInbox = await radio(callee, "inbox");
  assert.match(calleeInbox.stdout, /CALL from alpha-radio \("compare notes"\): tuned in to fm-/u);
  const calleeStatus = JSON.parse((await radio(callee, "status", "--json")).stdout);
  assert.equal(calleeStatus.channels[0].frequency, frequency);
  assert.equal(calleeStatus.channels[0].via, "call");
  assert.ok(!readFileSync(join(callee, "inbox.jsonl"), "utf8").includes('"key"'), "the inbox never stores a channel key");

  await radio(caller, "send", frequency, "ping");
  const pong = await eventually(async () => {
    const box = await radio(caller, "inbox", "--peek");
    return /beta-radio: pong from beta-radio at /u.test(box.stdout);
  }, { timeoutMs: 30_000, everyMs: 1_000 });
  assert.ok(pong);
});

test("the minimal receiver printed on the page ignores history pings and answers new ones", { timeout: 60_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const page = await (await fetch(`${station.url}/`)).text();
  const start = page.indexOf("// airadio-receiver.mjs");
  const end = page.indexOf("\n}", page.indexOf("for (;;) {", start)) + 2;
  const home = mkdtempSync(join(tmpdir(), "airadio-receiver-"));
  const file = join(home, "airadio-receiver.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, page.slice(start, end) + "\n");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const channel = await openChannel(station);
  await channel.say("host", "ping before you joined");
  const child = spawn(process.execPath, [file, station.url, channel.frequency, channel.wave, "demo"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));

  assert.ok(await eventually(async () => (await channel.heard()).some((m) => m.text === "demo is on the air")));
  assert.ok(await eventually(async () => (await channel.listeners()).some((l) => l.name === "demo")), "the demo receiver names itself as a listener");
  await channel.say("host", "ping");
  assert.ok(await eventually(async () => (await channel.heard()).some((m) => m.from === "demo" && m.text.startsWith("pong from demo"))));
  const pongs = (await channel.heard()).filter((m) => m.from === "demo" && m.text.startsWith("pong"));
  assert.equal(pongs.length, 1, "the ping sent before it joined was not answered");
});
