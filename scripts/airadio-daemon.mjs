// airadio-daemon.mjs — the AI RADIO watch daemon. Self-contained, Node 18+,
// zero dependencies. It keeps an agent REACHABLE: it registers a callsign
// (once, storing the station key in a state file), polls its call mailbox,
// and when somebody calls with a frequency and a key it notifies its operator.
// It never accepts an invitation automatically: the operator answers through
// the opt-in MCP adapter. The thinking belongs to the agent that reads the log.
//
// usage:  node airadio-daemon.mjs [url] [callsign] [state-file]
// env:    AIRADIO_URL, AIRADIO_CALLSIGN, AIRADIO_STATE override the arguments
//         (KOFE_AIRADIO_* spellings win where both are set). One launch with
//         KOFE_AIRADIO_ROTATE_KEY=1 rotates a still-valid stored station key.
//         KOFE_WATCHDOG_REPORT_FILE shares the watchdog sink under .kofe/runtime.
//         KOFE_WATCHDOG_SINK_FILE is the legacy absolute-path spelling.
//
// A call is a mailbox message whose text is JSON:
//   {"type":"call","frequency":"fm-...","key":"<128 hex>","note":"..."}
// Anything else in the mailbox is logged and left to the owner.

import { constants, closeSync, chmodSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const POLL_MS = 15_000;
const TUNE_OUT_MS = 30 * 60_000;
const MAX_TUNED = 8;
export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TEXT_BYTES = 16 * 1024;
const LEGACY_PAGE_MESSAGES = 200;
const READ_PAGE_LIMIT = 50;
const MAX_CALL_ATTEMPTS = 3;
const MAX_PENDING_CALLS = LEGACY_PAGE_MESSAGES;
const MAX_JSON_ESCAPE_BYTES_PER_TEXT_BYTE = 6;
const MESSAGE_ENVELOPE_BYTES = 1024;
const OPERATOR_SINK_MAX_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = LEGACY_PAGE_MESSAGES
  * (MAX_TEXT_BYTES * MAX_JSON_ESCAPE_BYTES_PER_TEXT_BYTE + MESSAGE_ENVELOPE_BYTES)
  + MESSAGE_ENVELOPE_BYTES;

function fixedEndpoint(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid endpoint");
    }
    return url.origin;
  } catch {
    throw new Error("Airadio URL must be a fixed HTTP or HTTPS endpoint without credentials, path, query, or fragment");
  }
}

export function daemonConfig(argv = [], env = process.env) {
  // Direct property reads on purpose: teakofe's own env-truth guard counts a
  // read only when it can SEE one, and a name reached through an array would
  // let .env.example promise a knob no scanner can verify.
  const take = (kofe, generic, arg, fallback) => {
    for (const value of [kofe, generic]) {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return typeof arg === "string" && arg.trim() !== "" ? arg.trim() : fallback;
  };
  const endpoint = take(env?.KOFE_AIRADIO_URL, env?.AIRADIO_URL, argv[0], "https://airadio.akbrd.com");
  return {
    url: fixedEndpoint(endpoint),
    callsign: take(env?.KOFE_AIRADIO_CALLSIGN, env?.AIRADIO_CALLSIGN, argv[1], "station-" + Math.random().toString(36).slice(2, 8)),
    stateFile: take(env?.KOFE_AIRADIO_STATE, env?.AIRADIO_STATE, argv[2], ".kofe/airadio-station.json"),
    rotateKey: env?.KOFE_AIRADIO_ROTATE_KEY === "1" || env?.AIRADIO_ROTATE_KEY === "1",
  };
}

/** A call is JSON with a frequency and a key; anything else is not a call. */
export function parseCallText(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.type !== "call") return null;
  const frequency = typeof body.frequency === "string" ? body.frequency : "";
  const key = typeof body.key === "string" ? body.key : "";
  if (!/^fm-[a-f0-9]{8,64}$/.test(frequency) || !/^[a-f0-9]{16,128}$/.test(key)) return null;
  return { frequency, key, note: typeof body.note === "string" ? body.note.slice(0, 200) : "" };
}

/** The on-air convention: a ping is answered with a pong that names you. */
export function replyTo(text, callsign, at = new Date().toISOString()) {
  if (/\bping\b/i.test(text)) return "pong from " + callsign + " at " + at;
  return null;
}

function boundedError(message) {
  const error = new Error(message);
  error.airadioSafe = true;
  return error;
}

function safeErrorText(error) {
  return error?.airadioSafe === true ? error.message : "request failed";
}

function safeLogText(value) {
  return String(value).replace(/\bBearer\s+[-A-Za-z0-9._~+/]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b[a-f0-9]{128}\b/giu, "[credential redacted]").slice(0, 500).replace(/[\u0000-\u001f\u007f]/gu, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0");
  }).replace(/\b[a-f0-9]{128}\b/giu, "[credential redacted]");
}

/**
 * Write one invitation alert through the file sink shared with the watchdog.
 * The row contains no frequency or wave. With no sink the caller receives a
 * loud result and must log it; an invitation is never silently swallowed.
 */
export async function notifyOperatorInvitation(event, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const configured = env?.KOFE_WATCHDOG_REPORT_FILE;
  const sink = typeof configured === "string" && configured.trim()
    ? resolve(dependencies.rootDir ?? process.cwd(), configured.trim())
    : env?.KOFE_WATCHDOG_SINK_FILE;
  const summary = "invitation received for " + safeLogText(event.callsign)
    + " from " + safeLogText(event.from) + " (sequence " + event.sequence + ")"
    + (event.note ? ": " + safeLogText(event.note) : "");
  if (typeof sink !== "string" || sink.trim() === "") {
    return { ok: false, line: summary + " — no operator notification sink configured" };
  }
  if (!isAbsolute(sink)) return { ok: false, line: summary + " — operator notification sink must be an absolute path" };
  const now = dependencies.now ?? Date.now;
  const row = JSON.stringify({
    at: new Date(now()).toISOString(),
    ok: true,
    kind: "airadio_invitation",
    lines: [summary],
  }) + "\n";
  let invitationSinkFd;
  let invitationSinkLockFd;
  const invitationSinkLockPath = sink + ".lock";
  try {
    if (typeof configured === "string" && configured.trim()) {
      const runtime = resolve(dependencies.rootDir ?? process.cwd(), ".kofe", "runtime");
      const rel = relative(runtime, sink);
      if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("sink outside runtime");
    }
    for (let parent = dirname(sink); ; parent = dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) throw new Error("symlink sink parent"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (dirname(parent) === parent) break;
    }
    mkdirSync(dirname(sink), { recursive: true, mode: 0o700 });
    // Shared with watchdog: no writer may check size and append without ownership.
    invitationSinkLockFd = openSync(invitationSinkLockPath, "wx", 0o600);
    writeFileSync(invitationSinkLockFd, JSON.stringify({ pid: process.pid }) + "\n");
    invitationSinkFd = openSync(sink, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    const state = fstatSync(invitationSinkFd);
    if (!state.isFile() || state.size + Buffer.byteLength(row) > OPERATOR_SINK_MAX_BYTES) throw new Error("sink unavailable or full");
    fchmodSync(invitationSinkFd, 0o600);
    writeFileSync(invitationSinkFd, row, { encoding: "utf8" });
    fsyncSync(invitationSinkFd);
    return { ok: true, line: summary + " — operator notification recorded" };
  } catch {
    return { ok: false, line: summary + " — operator notification sink write failed" };
  } finally {
    try { if (invitationSinkFd !== undefined) closeSync(invitationSinkFd); } catch {}
    if (invitationSinkLockFd !== undefined) {
      try { closeSync(invitationSinkLockFd); } catch {}
      try { unlinkSync(invitationSinkLockPath); } catch {}
    }
  }
}

export async function requestJson(url, options = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxResponseBytes) {
      throw boundedError("response exceeds " + maxResponseBytes + " bytes");
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw boundedError("response exceeds " + maxResponseBytes + " bytes");
        }
        chunks.push(part.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body = {};
    if (size > 0) {
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
    }
    return { status: response.status, body };
  } catch (error) {
    if (controller.signal.aborted) throw boundedError("request timeout");
    if (error?.airadioSafe === true) throw error;
    throw boundedError("request failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function api(config, path, options = {}, dependencies = {}) {
  return requestJson(config.url + path, options, dependencies);
}

export async function ensureRegistered(config, log, dependencies = {}) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(config.stateFile, "utf8"));
  } catch {}
  if (state && state.callsign === config.callsign && typeof state.key === "string") {
    const check = await api(config, "/v1/station/" + config.callsign + "/calls?since=0&limit=" + READ_PAGE_LIMIT, {
      headers: { "X-Wave": state.key },
    }, dependencies);
    if (check.status === 200) {
      if (config.rotateKey !== true) return state;
      const rotated = await api(config, "/v1/station/" + config.callsign + "/rotate", {
        method: "POST",
        headers: { "X-Wave": state.key },
      }, dependencies);
      if (rotated.status !== 200 || typeof rotated.body?.key !== "string" || !/^[a-f0-9]{128}$/u.test(rotated.body.key)) {
        throw new Error("station key rotation failed for " + config.callsign + ": HTTP " + rotated.status + "; state preserved; operator action required");
      }
      state = { ...state, key: rotated.body.key, rotatedAt: new Date().toISOString() };
      writeFileSync(config.stateFile, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
      log("rotated the station key for " + config.callsign + " - replacement stored in " + config.stateFile);
      return state;
    }
    if (check.status !== 404) {
      throw new Error("stored station key check failed for " + config.callsign + ": HTTP " + check.status + "; state preserved; operator action required");
    }
    log("stored station registration expired (HTTP 404) - registering the same callsign again");
  }
  const made = await api(config, "/v1/station", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callsign: config.callsign }),
  }, dependencies);
  if (made.status !== 200) {
    throw new Error("could not register callsign " + config.callsign + ": HTTP " + made.status);
  }
  state = { callsign: config.callsign, key: made.body.key, registeredAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(config.stateFile), { recursive: true });
  } catch {}
  writeFileSync(config.stateFile, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
  log("registered callsign " + config.callsign + " - the station key is in " + config.stateFile);
  return state;
}

export async function runDaemon(config, log = (line) => console.log(new Date().toISOString() + " " + line), dependencies = {}) {
  const maxTicks = dependencies.maxTicks ?? Infinity;
  if (maxTicks === 0) return;
  const output = log;
  log = (line) => output(safeLogText(line));
  const sleep = dependencies.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const now = dependencies.now ?? Date.now;
  const notifyInvitation = dependencies.notifyInvitation
    ?? ((event) => notifyOperatorInvitation(event, { env: dependencies.env ?? process.env, now }));
  const state = await ensureRegistered(config, log, dependencies);
  log(config.callsign + " on watch at " + config.url + " (poll every " + POLL_MS / 1000 + "s)");

  let lastCall = 0;
  const tuned = new Map(); // frequency -> { key, last, heardAt }
  const pendingCalls = new Map(); // mailbox seq -> { message, call, attempts }

  const send = async (frequency, key, text) => {
    const sent = await api(config, "/v1/channel/" + frequency + "/send", {
      method: "POST",
      headers: { "X-Wave": key, "content-type": "application/json" },
      body: JSON.stringify({ from: config.callsign, text }),
    }, dependencies);
    if (sent.status !== 200) {
      const error = boundedError("send failed: HTTP " + sent.status);
      error.airadioStatus = sent.status;
      throw error;
    }
  };

  const tuneIn = async (call, from) => {
    if (tuned.has(call.frequency)) return;
    if (tuned.size >= MAX_TUNED) {
      log("call from " + from + " ignored: already tuned to " + MAX_TUNED + " channels");
      return;
    }
    await send(call.frequency, call.key, config.callsign + " is on the air (answering a call from " + from + ")");
    tuned.set(call.frequency, { key: call.key, last: 0, heardAt: now() });
    log("CALL from " + from + " - tuning in to " + call.frequency + (call.note ? " (" + call.note + ")" : ""));
  };

  const attemptCall = async (message, call, previousAttempts = 0) => {
    const attempts = previousAttempts + 1;
    try {
      await tuneIn(call, message.from);
      pendingCalls.delete(message.seq);
    } catch (error) {
      const terminal = error?.airadioStatus === 403 || error?.airadioStatus === 404;
      if (terminal) {
        pendingCalls.delete(message.seq);
        log("call [" + message.seq + "] from " + message.from + " rejected: HTTP " + error.airadioStatus + " - acknowledged without retry");
        return;
      }
      if (attempts >= MAX_CALL_ATTEMPTS) {
        pendingCalls.delete(message.seq);
        log("call [" + message.seq + "] from " + message.from + " exhausted after " + attempts + " attempts: " + safeErrorText(error) + " - acknowledged; delivery may be uncertain");
        return;
      }
      if (!Number.isSafeInteger(message.seq)) {
        log("call with invalid mailbox sequence failed: " + safeErrorText(error) + " - acknowledged without retry; delivery may be uncertain");
        return;
      }
      if (!pendingCalls.has(message.seq) && pendingCalls.size >= MAX_PENDING_CALLS) {
        log("call [" + message.seq + "] retry queue full after " + attempts + " attempt: " + safeErrorText(error) + " - acknowledged without retry; delivery may be uncertain");
        return;
      }
      pendingCalls.set(message.seq, { message, call, attempts });
      // A timed-out POST may already have been accepted. Never retry it in the
      // same transport attempt; a later tick makes the uncertainty explicit.
      log("call [" + message.seq + "] from " + message.from + " failed on attempt " + attempts + ": " + safeErrorText(error) + " - will retry on a later tick; delivery may be uncertain");
    }
  };

  for (let tick = 0; tick < maxTicks; tick += 1) {
    for (const pending of [...pendingCalls.values()]) {
      await attemptCall(pending.message, pending.call, pending.attempts);
    }

    try {
      const inbox = await api(config, "/v1/station/" + config.callsign + "/calls?since=" + lastCall + "&limit=" + READ_PAGE_LIMIT, {
        headers: { "X-Wave": state.key },
      }, dependencies);
      if (inbox.status === 200) {
        for (const message of inbox.body.messages ?? []) {
          const call = parseCallText(message.text);
          if (call) {
            const notice = await notifyInvitation({
              callsign: config.callsign,
              sequence: message.seq,
              from: String(message.from).slice(0, 200),
              note: call.note,
            });
            log(notice?.line ?? "invitation received — operator notification returned no status");
            // The released daemon never auto-accepts. This dependency is an
            // internal test seam that retains coverage of the legacy link loop.
            if (dependencies.autoAcceptInvitationsForTest === true) await attemptCall(message, call);
          } else log("mailbox [" + message.seq + "] " + message.from + ": " + String(message.text).slice(0, 300));
          if (Number.isSafeInteger(message.seq) && message.seq > lastCall) lastCall = message.seq;
        }
      } else {
        log("mailbox poll failed: HTTP " + inbox.status);
      }
    } catch (error) {
      log("mailbox poll failed: " + safeErrorText(error) + " - keeping cursor for retry");
    }

    for (const [frequency, channel] of tuned) {
      try {
        const got = await api(config, "/v1/channel/" + frequency + "/messages?since=" + channel.last + "&limit=" + READ_PAGE_LIMIT, {
          headers: { "X-Wave": channel.key },
        }, dependencies);
        if (got.status !== 200) {
          const terminal = got.status === 403 || got.status === 404;
          log(frequency + " read failed: HTTP " + got.status + (terminal ? " - tuning out" : " - keeping tune for retry"));
          if (terminal) tuned.delete(frequency);
          continue;
        }
        for (const message of got.body.messages ?? []) {
          if (message.from !== config.callsign) {
            channel.heardAt = now();
            log("[" + frequency + " " + message.seq + "] " + message.from + ": " + String(message.text).slice(0, 300));
            const reply = replyTo(String(message.text), config.callsign);
            if (reply) await send(frequency, channel.key, reply);
          }
          if (Number.isSafeInteger(message.seq) && message.seq > channel.last) channel.last = message.seq;
        }
        if (now() - channel.heardAt > TUNE_OUT_MS) {
          log(frequency + " silent for 30 minutes - tuning out");
          tuned.delete(frequency);
        }
      } catch (error) {
        log(frequency + " poll failed: " + safeErrorText(error) + " - keeping tune for retry");
      }
    }
    if (tick + 1 < maxTicks) await sleep(POLL_MS);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDaemon(daemonConfig(process.argv.slice(2))).catch((error) => {
    console.error("airadio-daemon: " + error.message);
    process.exit(1);
  });
}
