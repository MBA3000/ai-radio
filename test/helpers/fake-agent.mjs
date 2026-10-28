#!/usr/bin/env node
/**
 * A stand-in for the agent CLIs radio.mjs wakes (claude, codex, opencode,
 * agy, hermes). It speaks each CLI's real output format — captured live on
 * 2026-09-24 — and keeps a per-session memory on disk, so a test can prove
 * that the radio resumes the SAME session: "remember 4217" in one wake is
 * recalled in the next only if the session id came back.
 *
 * usage: node fake-agent.mjs <claude|codex|opencode|agy|hermes> <the CLI's own argv...>
 * env:   FAKE_AGENT_DIR  where sessions and the call log live
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [flavor, ...argv] = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("fake " + flavor + " 1.0.0\n");
  process.exit(0);
}
const dir = process.env.FAKE_AGENT_DIR;
mkdirSync(dir, { recursive: true });

const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const readStdin = () => {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
};

let prompt = "";
let session = null;
let resume = false;
if (flavor === "claude") {
  prompt = readStdin();
  resume = argv.includes("--resume");
  session = resume ? valueAfter("--resume") : valueAfter("--session-id");
} else if (flavor === "codex") {
  resume = argv[1] === "resume";
  session = resume ? argv[2] : "thread-" + Math.random().toString(16).slice(2, 10);
  prompt = readStdin();
} else if (flavor === "opencode") {
  resume = argv.includes("--session");
  session = resume ? valueAfter("--session") : "ses_" + Math.random().toString(16).slice(2, 10);
  prompt = argv[argv.length - 1];
} else if (flavor === "agy") {
  resume = argv.includes("--conversation");
  session = resume ? valueAfter("--conversation") : "conv-" + Math.random().toString(16).slice(2, 10);
  prompt = (argv.find((word) => word.startsWith("-p=")) || "-p=").slice(3);
} else if (flavor === "hermes") {
  resume = argv.includes("--resume");
  session = resume ? valueAfter("--resume") : "hermes-" + Math.random().toString(16).slice(2, 10);
  prompt = valueAfter("--query-file") === "-" ? readStdin() : "";
}

appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({
  flavor, argv, resume, session, prompt, cwd: process.cwd(), frequency: process.env.AIRADIO_FREQUENCY,
  opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT || null, airadioHome: process.env.AIRADIO_HOME || null,
}) + "\n");

const file = join(dir, "session-" + String(session).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
if (resume && !existsSync(file)) {
  if (flavor === "claude") process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID: " + session, session_id: session }) + "\n");
  else process.stderr.write("no such session " + session + "\n");
  process.exit(1);
}
const memory = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { turns: 0 };
memory.turns += 1;

// The newest message is the last "[hh:mm:ssZ] from: text" line of the prompt.
const lines = String(prompt).split("\n").filter((line) => /^\[[^\]]*\] [^:]+: /.test(line));
const newest = lines.length > 0 ? lines[lines.length - 1].replace(/^\[[^\]]*\] [^:]+: /, "") : "";
let reply;
if (/fail/i.test(newest)) {
  process.stderr.write("simulated failure\n");
  process.exit(3);
} else if (/remember (\d+)/i.test(newest)) {
  memory.number = /remember (\d+)/i.exec(newest)[1];
  reply = "noted " + memory.number;
} else if (/what number/i.test(newest)) {
  reply = "the number is " + (memory.number || "unknown") + " (turn " + memory.turns + ")";
} else if (/thanks/i.test(newest)) {
  reply = "NO_REPLY";
} else if (/take your time/i.test(newest)) {
  // A long turn, for tests that stop one midway.
  if (process.env.FAKE_AGENT_CHILD_ACT) {
    // A tool it started: in the agent's process group, deaf to SIGTERM, acting on its own a while later.
    const [file, ms] = process.env.FAKE_AGENT_CHILD_ACT.split(",");
    spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(" + JSON.stringify(file) + ", 'acted'), " + Number(ms) + ");"], { stdio: "ignore" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_AGENT_SLOW_MS) || 15_000);
  reply = "done, slowly";
} else if (/drop my key and answer/i.test(newest) && process.env.FAKE_AGENT_DROP_KEY && process.env.FAKE_AGENT_RADIO_JSON) {
  // The owner drops a device while the turn runs, right before it ends: no receiver
  // tick sees the turn again before its answer would be sent (the file is changed, nobody is poked).
  const config = JSON.parse(readFileSync(process.env.FAKE_AGENT_RADIO_JSON, "utf8"));
  for (const channel of Object.values(config.channels)) {
    if (Array.isArray(channel.devices)) channel.devices = channel.devices.filter((device) => device.key !== process.env.FAKE_AGENT_DROP_KEY);
  }
  writeFileSync(process.env.FAKE_AGENT_RADIO_JSON + ".tmp-fake", JSON.stringify(config));
  renameSync(process.env.FAKE_AGENT_RADIO_JSON + ".tmp-fake", process.env.FAKE_AGENT_RADIO_JSON);
  reply = "answered after the drop";
} else if (/hold the lock and answer/i.test(newest) && process.env.FAKE_AGENT_LOCK_FILE) {
  // Ends its turn while a drop holds the configuration lock (the test's own pid owns it).
  writeFileSync(process.env.FAKE_AGENT_LOCK_FILE, JSON.stringify({ id: "drop-in-progress", pid: Number(process.env.FAKE_AGENT_LOCK_PID) }));
  reply = "answered while the drop held the lock";
} else if (/leak/i.test(newest)) {
  reply = "here it is: " + "c".repeat(128);
} else {
  reply = "heard: " + newest;
}
writeFileSync(file, JSON.stringify(memory));

if (flavor === "claude") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply, session_id: session }) + "\n");
} else if (flavor === "codex") {
  const out = valueAfter("-o");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: session }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
  if (out) writeFileSync(out, reply);
} else if (flavor === "opencode") {
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: session }) + "\n");
  process.stdout.write(JSON.stringify({ type: "text", sessionID: session, part: { messageID: "msg_" + memory.turns, type: "text", text: reply } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", sessionID: session }) + "\n");
} else if (flavor === "agy") {
  process.stdout.write(JSON.stringify({ conversation_id: session, status: "SUCCESS", response: reply + "\n" }) + "\n");
} else if (flavor === "hermes") {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\n");
  process.stdout.write(JSON.stringify({ type: "text", delta: reply }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", text: reply, session_id: session, exit_code: 0, tokens: { input: 10, output: 5 } }) + "\n");
}
