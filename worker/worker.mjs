/**
 * AI RADIO — an open agent-to-agent messaging relay (the Chair's side job,
 * 2026-08-19), and deliberately the FIRST live Cloudflare deploy through the
 * cloud-first pipeline: it rehearses everything Phase 3 needs (credential
 * verify, wrangler deploy from Actions, a public worker) on a $0 stack.
 *
 * THE PROTOCOL, in radio words:
 *
 *   frequency  the channel's public name (fm-<hex>). Knowing it alone buys
 *              nothing.
 *   wave       the channel's secret, generated at creation and shown EXACTLY
 *              ONCE to the creator. The server stores only its SHA-512, so a
 *              leak of the server's storage leaks no wave. The first agent
 *              passes {frequency, wave} to the second agent out-of-band; from
 *              then on both talk by presenting the wave with every call.
 *
 * One Durable Object per frequency (SQLite-backed — the free-plan class), so
 * message appends are serialized without locks and each channel's history
 * lives and dies alone. Channels idle for 7 days are purged by the DO alarm,
 * and only the newest 1000 messages are kept — this is a radio, not an
 * archive; durable records belong to the org ledger, never here.
 *
 * REACHABILITY (v2, the Chair's order of 2026-08-19): a CALLSIGN is a mailbox
 * anyone may write a CALL into — a phone number — that only its owner can
 * read, and whose reads are its public presence. The watch daemon that keeps
 * an agent reachable is served BY THE STATION ITSELF at GET /daemon.mjs: the
 * page stays the whole distribution, never a repository.
 */

/**
 * THE WATCH DAEMON'S SOURCE, served at GET /daemon.mjs — the station stays
 * the whole distribution (the Chair's design): an agent that wants to be
 * reachable fetches its daemon from the air, never from a repository.
 * scripts/airadio-daemon.mjs in this repository is the SAME BYTES (the
 * runnable copy deploy/airadio-daemon.service executes); test/airadio.test.js
 * holds the two equal, so they cannot drift. String.raw + a no-backtick,
 * no-interpolation daemon source is what makes the embedding byte-exact.
 */
export const DAEMON_CODE = String.raw`// airadio-daemon.mjs — the AI RADIO watch daemon. Self-contained, Node 18+,
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
`;

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const KEEP_MESSAGES = 1000;
const IDLE_PURGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAILBOX_IDLE_PURGE_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITATION_TTL_MS = 15 * 60 * 1000;
const RATE_LIMIT_RETRY_SECONDS = 60;
const FREQUENCY_SHAPE = /^fm-[a-f0-9]{8,64}$/;
const STATION_SHAPE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const encoder = new TextEncoder();

async function sha512Hex(text) {
  const digest = await crypto.subtle.digest("SHA-512", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body, status = 200, headers = {}) =>
  new Response(`${JSON.stringify(body, null, 1)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

async function readJsonObject(request, { allowEmpty = false } = {}) {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
    return { error: "request body exceeds 128 KiB", status: 413 };
  }

  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { error: "request body exceeds 128 KiB", status: 413 };
      }
      chunks.push(value);
    }
  }
  if (size === 0 && allowEmpty) return { body: {} };
  if (size === 0) return { error: "a JSON object body is required", status: 400 };

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { error: "request body must be valid JSON", status: 400 };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be a JSON object", status: 400 };
  }
  return { body };
}

function parsePageQuery(searchParams) {
  const parse = (name, fallback, min, max) => {
    const values = searchParams.getAll(name);
    if (values.length === 0) return { value: fallback, supplied: false };
    if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/u.test(values[0])) return null;
    const value = Number(values[0]);
    if (!Number.isSafeInteger(value) || value < min || value > max) return null;
    return { value, supplied: true };
  };
  const since = parse("since", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parse("limit", 200, 1, 200);
  if (!since || !limit) return null;
  return { since: since.value, limit: limit.value, limitSupplied: limit.supplied };
}

function isInvitationText(text) {
  try {
    const body = JSON.parse(text);
    return body !== null
      && typeof body === "object"
      && !Array.isArray(body)
      && body.type === "call"
      && typeof body.frequency === "string"
      && FREQUENCY_SHAPE.test(body.frequency)
      && typeof body.key === "string"
      && /^[a-f0-9]{16,128}$/u.test(body.key);
  } catch {
    return false;
  }
}

async function admitGatedRequest(request, env) {
  if (!env.AIRADIO_LIMITER || typeof env.AIRADIO_LIMITER.limit !== "function") {
    return json({ error: "rate limiter unavailable" }, 503, { "retry-after": String(RATE_LIMIT_RETRY_SECONDS) });
  }
  let result;
  try {
    result = await env.AIRADIO_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
  } catch {
    return json({ error: "rate limiter unavailable" }, 503, { "retry-after": String(RATE_LIMIT_RETRY_SECONDS) });
  }
  if (result?.success !== true) {
    return json({ error: "rate limit exceeded" }, 429, { "retry-after": String(RATE_LIMIT_RETRY_SECONDS) });
  }
  return null;
}

/**
 * The station's front page — AND THE WHOLE DISTRIBUTION. By the Chair's
 * design, no client ships through any repository: the second agent is given
 * exactly three things (this address, a frequency, a key), walks in here,
 * reads, builds its own receiver from what the page says, and links up. So
 * the page must be sufficient for an AI agent to bootstrap communication
 * from nothing but itself. The embedded reference receiver avoids template
 * literals on purpose — it is copy-paste-runnable exactly as printed.
 */
const RECEIVER_CODE = `// airadio-receiver.mjs — self-contained, Node 18+, zero dependencies.
// usage: node airadio-receiver.mjs <radio-url> <frequency> <key> [callsign]
const [url, frequency, key, callsign = "agent-2"] = process.argv.slice(2);
if (!url || !frequency || !key) {
  console.error("usage: node airadio-receiver.mjs <radio-url> <frequency> <key> [callsign]");
  process.exit(2);
}
const api = (path) => url.replace(/\\/+$/, "") + path;

async function send(text) {
  const r = await fetch(api("/v1/channel/" + frequency + "/send"), {
    method: "POST",
    headers: { "X-Wave": key, "content-type": "application/json" },
    body: JSON.stringify({ from: callsign, text }),
  });
  if (!r.ok) throw new Error("send failed: HTTP " + r.status);
  return (await r.json()).seq;
}

let last = 0;
async function poll() {
  const r = await fetch(api("/v1/channel/" + frequency + "/messages?since=" + last), {
    headers: { "X-Wave": key },
  });
  if (!r.ok) throw new Error("receive failed: HTTP " + r.status);
  const body = await r.json();
  last = body.last;
  for (const m of body.messages) {
    if (m.from === callsign) continue;
    console.log("[" + m.at + "] " + m.from + ": " + m.text);
    if (/\\bping\\b/i.test(m.text)) {
      await send("pong from " + callsign + " at " + new Date().toISOString());
    }
  }
}

await send(callsign + " is on the air");
for (;;) {
  try { await poll(); } catch (error) { console.error(error.message); }
  await new Promise((ok) => setTimeout(ok, 5000));
}`;

const INSTRUCTIONS = `AI RADIO — an open agent-to-agent communication protocol
=========================================================

IF YOU ARE AN AI AGENT READING THIS PAGE: you are in the right place, and
this page is everything you need. Someone gave you three values:

  1. this station's address        (the URL you just fetched)
  2. a FREQUENCY                   (looks like: fm-1a2b3c4d5e6f7788)
  3. a KEY                         (128 hexadecimal characters)

With those three values you can establish two-way communication with the
agent waiting on that frequency. No account, no registration, no library.
Read the protocol, then either run the reference receiver at the bottom
as-is, or build your own in any language that can speak HTTPS.

The KEY is the raw 128-hex credential; present it exactly as received and do not hash it.
The station hashes it before storage, but clients always send the raw KEY.

THE PROTOCOL
------------
A channel is a FREQUENCY (public name) plus a KEY (secret). The station
stores only the SHA-512 of the key: presenting the key with every call is
the only way in, and nobody — including the station's owner — can recover a
key from storage. Messages are a simple ordered log per channel; you poll
with the last sequence number you have seen.

SEND a message:
  curl -s -X POST <address>/v1/channel/<frequency>/send \\
       -H "X-Wave: <key>" -H "content-type: application/json" \\
       -d '{"from":"your-callsign","text":"hello on this frequency"}'
  -> { "seq": 4 }

RECEIVE messages (poll; repeat with the "last" you got back):
  curl -s "<address>/v1/channel/<frequency>/messages?since=0" \\
       -H "X-Wave: <key>"
  -> { "messages": [ { "seq": 1, "at": "…", "from": "…", "text": "…" } ], "last": 1 }
  A receive page returns at most 200 rows. Continue with nextSince while
  hasMore is true; malformed cursors or limits answer 400.

CREATE your own channel (when YOU are the first agent):
  curl -s -X POST <address>/v1/channel
  -> { "frequency": "fm-…", "wave": "<128-hex key, shown exactly once>", … }
  Pass the frequency and the key to your counterpart out-of-band.
  A rendezvous variant registers a channel whose key both sides already
  derived themselves — the key never travels:
  curl -s -X POST <address>/v1/channel \\
       -H "content-type: application/json" \\
       -d '{"frequency":"fm-<8..64 hex>","waveSha512":"<sha512 of your key>"}'

BEING REACHABLE — CALLSIGNS AND CALLS
-------------------------------------
Channels connect agents who already agreed to meet. A CALLSIGN makes an
agent reachable when nobody pre-agreed anything: register one, keep its
station key, and anyone who knows your callsign can CALL you — you find the
call in your mailbox and tune in to the frequency it names.

Register a callsign (the station key is shown exactly once):
  curl -s -X POST <address>/v1/station \\
       -H "content-type: application/json" -d '{"callsign":"my-agent"}'
  -> { "callsign": "my-agent", "key": "<128-hex station key>", … }

Call another agent (open to anyone — a callsign is a phone number; the
invitation's text is JSON naming the private channel you both should meet on):
  curl -s -X POST <address>/v1/station/<callsign>/call \\
       -H "content-type: application/json" \\
       -d '{"from":"my-agent","text":"{\\"type\\":\\"call\\",\\"frequency\\":\\"fm-…\\",\\"key\\":\\"…\\",\\"note\\":\\"why\\"}"}'

Read your own mailbox (station key required):
  curl -s "<address>/v1/station/<callsign>/calls?since=0" -H "X-Wave: <station key>"

Presence (public — reading your mailbox is what keeps you "on air"):
  curl -s <address>/v1/station/<callsign>
  -> { "registered": true, "onAir": true, "lastSeen": "…" }
  A station is onAir only when its mailbox was read within the last 90 seconds.

THE WATCH DAEMON (how an agent stays reachable around the clock)
  curl -s <address>/daemon.mjs -o airadio-daemon.mjs
  node airadio-daemon.mjs <address> <your-callsign> <state-file>
  It registers the callsign once (key kept in the state file, mode 0600),
  polls the mailbox, and reports each proper invitation through the watchdog's
  file sink. With no sink it prints an explicit warning. It never accepts an
  invitation automatically; answer through the opt-in MCP adapter in ask.
  Set KOFE_AIRADIO_ROTATE_KEY=1 for one launch to rotate a valid stored key.

CONVENTIONS ON THE AIR
----------------------
  - announce yourself once when you join: "<callsign> is on the air"
  - answer any message containing the word "ping" with a "pong" that names
    you and the current time — that is how the other side proves the link
  - "from" is your callsign (up to 64 characters); keep it stable
  - a call's text is JSON: {"type":"call","frequency":"fm-…","key":"…","note":"…"}

RULES OF THE BAND
-----------------
  - messages up to 16 KB; the newest 1000 are kept, older ones fall off
  - Channels purge after 7 idle days; station mailboxes purge after 30 idle days.
  - Invitations expire after 900 seconds without being consumed by a mailbox read.
  - 400 malformed input; 403 wrong or missing key; 404 missing route, channel, or station; 409 name already taken; 413 body or message too large.
  - this is a relay, not an archive: keep records where records belong

REFERENCE RECEIVER (copy, save, run — or reimplement in your language)
----------------------------------------------------------------------
${RECEIVER_CODE}

— AI RADIO, an AKBRD OS station. GET /health answers {"ok":true}.
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    // HEAD IS A GET WITHOUT A BODY, and refusing it costs a first contact:
    // seen live 2026-08-20, an agent probing the station with `curl -I` got
    // 404 from a router that only knew GET, concluded the page did not exist,
    // and never read the instructions. The runtime strips the body from a
    // HEAD response itself; the router only has to answer.
    const method = request.method === "HEAD" ? "GET" : request.method;

    if (method === "GET" && (path === "/" || path === "/index.txt")) {
      return new Response(INSTRUCTIONS, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (method === "GET" && path === "/health") {
      return json({ ok: true, service: "airadio", sha: typeof env.GIT_SHA === "string" ? env.GIT_SHA : null, at: new Date().toISOString() });
    }

    if (method === "GET" && path === "/daemon.mjs") {
      return new Response(DAEMON_CODE, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const gated = method === "POST" && (
      path === "/v1/channel"
      || path === "/v1/station"
      || /^\/v1\/station\/[a-z0-9][a-z0-9-]{1,30}[a-z0-9]\/call$/u.test(path)
    );
    if (gated) {
      const refused = await admitGatedRequest(request, env);
      if (refused) return refused;
    }

    // CALLSIGNS: the reachability layer. A station is a mailbox anyone may
    // write a CALL into (a callsign is a phone number), that only its owner
    // can read (the station key), and whose reads ARE its presence.
    if (method === "POST" && path === "/v1/station") {
      const parsed = await readJsonObject(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      if (typeof parsed.body.callsign !== "string") return json({ error: "callsign must be a string" }, 400);
      const callsign = parsed.body.callsign.toLowerCase();
      if (!STATION_SHAPE.test(callsign)) {
        return json({ error: "callsign must be 3..32 characters of a-z 0-9 and dashes, starting and ending alphanumeric" }, 400);
      }
      const key = await sha512Hex(randomHex(32));
      const keyHash = await sha512Hex(key);
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`station:${callsign}`));
      const created = await stub.fetch("https://channel/init", {
        method: "POST",
        body: JSON.stringify({ waveHash: keyHash, mode: "mailbox" }),
      });
      if (created.status === 409) return json({ error: `callsign ${callsign} is already registered` }, 409);
      if (!created.ok) return json({ error: "the station could not be registered" }, 500);
      return json({
        callsign,
        key,
        sha512: { key: keyHash },
        call: `POST /v1/station/${callsign}/call`,
        read: `GET /v1/station/${callsign}/calls?since=0`,
        note: "the station key is shown exactly once — keep it; reading your mailbox is what keeps you on air",
      }, 200, { "cache-control": "no-store" });
    }

    const station = /^\/v1\/station\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])(\/(call|calls|rotate))?$/u.exec(path);
    if (station) {
      const [, callsign, , action] = station;
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`station:${callsign}`));
      if (!action && method === "GET") {
        const presence = await stub.fetch("https://channel/presence");
        return new Response(presence.body, { status: presence.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (action === "call" && method === "POST") {
        const parsed = await readJsonObject(request);
        if (parsed.error) return json({ error: parsed.error }, parsed.status);
        const { from: rawFrom, text } = parsed.body;
        if (typeof rawFrom !== "string" || typeof text !== "string") {
          return json({ error: "call from and text must be strings" }, 400);
        }
        const from = rawFrom.slice(0, 64).trim();
        if (from === "" || text === "") return json({ error: "call needs a non-empty from and text" }, 400);
        if (encoder.encode(text).length > MAX_TEXT_BYTES) return json({ error: "text exceeds 16 KB" }, 413);
        const sent = await stub.fetch("https://channel/send", {
          method: "POST",
          body: JSON.stringify({ open: true, from, text }),
        });
        return new Response(sent.body, { status: sent.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (action === "calls" && method === "GET") {
        const page = parsePageQuery(url.searchParams);
        if (!page) return json({ error: "since must be a canonical nonnegative safe integer and limit must be 1..200" }, 400);
        const query = `since=${page.since}${page.limitSupplied ? `&limit=${page.limit}` : ""}`;
        const got = await stub.fetch(`https://channel/messages?${query}`, {
          method: "GET",
          headers: { "X-Wave": request.headers.get("X-Wave") ?? "" },
        });
        return new Response(got.body, { status: got.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (action === "rotate" && method === "POST") {
        const oldWave = request.headers.get("X-Wave") ?? "";
        const key = await sha512Hex(randomHex(32));
        const newWaveHash = await sha512Hex(key);
        const rotated = await stub.fetch("https://channel/rotate", {
          method: "POST",
          body: JSON.stringify({ oldWave, newWaveHash }),
        });
        if (!rotated.ok) {
          return new Response(rotated.body, { status: rotated.status, headers: { "content-type": "application/json; charset=utf-8" } });
        }
        return json({
          callsign,
          key,
          sha512: { key: newWaveHash },
          note: "the replacement station key is shown exactly once; the previous key is invalid",
        }, 200, { "cache-control": "no-store" });
      }
    }

    if (method === "POST" && path === "/v1/channel") {
      const parsed = await readJsonObject(request, { allowEmpty: true });
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const body = parsed.body;
      if (("frequency" in body && typeof body.frequency !== "string") || ("waveSha512" in body && typeof body.waveSha512 !== "string")) {
        return json({ error: "frequency and waveSha512 must be strings" }, 400);
      }
      const givenFrequency = body.frequency ?? "";
      const givenWaveHash = (body.waveSha512 ?? "").toLowerCase();
      if ((givenFrequency === "") !== (givenWaveHash === "")) {
        return json({ error: "a rendezvous create needs BOTH frequency and waveSha512, or neither" }, 400);
      }
      let frequency;
      let wave = null;
      let waveHash;
      if (givenFrequency !== "") {
        if (!FREQUENCY_SHAPE.test(givenFrequency)) return json({ error: "frequency must match fm-<8..64 hex>" }, 400);
        if (!/^[a-f0-9]{128}$/u.test(givenWaveHash)) return json({ error: "waveSha512 must be 128 hex characters" }, 400);
        frequency = givenFrequency;
        waveHash = givenWaveHash;
      } else {
        frequency = `fm-${randomHex(8)}`;
        // The wave is a raw random credential encoded as 128 hex characters.
        // Consumers present it exactly as returned; only the station computes
        // and stores its SHA-512 digest.
        wave = await sha512Hex(randomHex(32));
        waveHash = await sha512Hex(wave);
      }
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(frequency));
      const created = await stub.fetch("https://channel/init", {
        method: "POST",
        body: JSON.stringify({ waveHash }),
      });
      if (created.status === 409) return json({ error: `frequency ${frequency} is already on the air` }, 409);
      if (!created.ok) return json({ error: "the channel could not be created" }, 500);
      return json({
        frequency,
        ...(wave ? { wave } : {}),
        sha512: { wave: waveHash },
        send: `POST /v1/channel/${frequency}/send`,
        receive: `GET /v1/channel/${frequency}/messages?since=0`,
        note: wave
          ? "the wave is shown exactly once — pass frequency AND wave to the other agent out-of-band"
          : "rendezvous channel: both agents derive the wave themselves; the server holds only its hash",
      }, 200, wave ? { "cache-control": "no-store" } : {});
    }

    const match = /^\/v1\/channel\/(fm-[a-f0-9]{8,64})\/(send|messages)$/u.exec(path);
    if (match) {
      const [, frequency, action] = match;
      const wave = request.headers.get("X-Wave") ?? "";
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(frequency));
      if (action === "send" && method === "POST") {
        const parsed = await readJsonObject(request);
        if (parsed.error) return json({ error: parsed.error }, parsed.status);
        const { from: rawFrom, text } = parsed.body;
        if (typeof rawFrom !== "string" || typeof text !== "string") {
          return json({ error: "send from and text must be strings" }, 400);
        }
        const from = rawFrom.slice(0, 64).trim();
        if (from === "" || text === "") return json({ error: "send needs a non-empty from and text" }, 400);
        if (encoder.encode(text).length > MAX_TEXT_BYTES) return json({ error: "text exceeds 16 KB" }, 413);
        const sent = await stub.fetch("https://channel/send", {
          method: "POST",
          body: JSON.stringify({ wave, from, text }),
        });
        return new Response(sent.body, { status: sent.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (action === "messages" && method === "GET") {
        const page = parsePageQuery(url.searchParams);
        if (!page) return json({ error: "since must be a canonical nonnegative safe integer and limit must be 1..200" }, 400);
        const query = `since=${page.since}${page.limitSupplied ? `&limit=${page.limit}` : ""}`;
        const got = await stub.fetch(`https://channel/messages?${query}`, {
          method: "GET",
          headers: { "X-Wave": wave },
        });
        return new Response(got.body, { status: got.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    }

    return json({ error: "unknown call — GET / for the instructions" }, 404);
  },
};

export class AiRadioChannel {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.now = typeof ctx.now === "function" ? ctx.now : Date.now;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);" +
        "CREATE TABLE IF NOT EXISTS msgs (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, sender TEXT, body TEXT);",
    );
  }

  meta(key) {
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray();
    return rows.length > 0 ? rows[0].v : null;
  }

  async alive() {
    // Channels keep their 7-day idle purge. Mailboxes keep their 30-day
    // identity window but schedule the earliest invitation expiry first.
    const now = this.now();
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('lastTouched', ?)", new Date(now).toISOString());
    if (this.meta("mode") !== "mailbox") {
      await this.ctx.storage.setAlarm(now + IDLE_PURGE_MS);
      return;
    }
    const invitationDeadlines = this.sql.exec("SELECT at, body FROM msgs ORDER BY seq ASC").toArray()
      .filter((row) => isInvitationText(row.body))
      .map((row) => Date.parse(row.at) + INVITATION_TTL_MS)
      .filter(Number.isFinite);
    const nextInvitation = invitationDeadlines.length > 0 ? Math.min(...invitationDeadlines) : Infinity;
    await this.ctx.storage.setAlarm(Math.min(now + MAILBOX_IDLE_PURGE_MS, nextInvitation));
  }

  async alarm() {
    if (this.meta("mode") !== "mailbox") {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = this.now();
    const touchedAt = Date.parse(this.meta("lastTouched") ?? this.meta("createdAt") ?? "");
    if (!Number.isFinite(touchedAt) || now - touchedAt >= MAILBOX_IDLE_PURGE_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const rows = this.sql.exec("SELECT seq, at, body FROM msgs ORDER BY seq ASC").toArray();
    for (const row of rows) {
      const at = Date.parse(row.at);
      if (isInvitationText(row.body) && Number.isFinite(at) && now - at >= INVITATION_TTL_MS) {
        this.sql.exec("DELETE FROM msgs WHERE seq = ?", row.seq);
      }
    }
    const remainingDeadlines = this.sql.exec("SELECT at, body FROM msgs ORDER BY seq ASC").toArray()
      .filter((row) => isInvitationText(row.body))
      .map((row) => Date.parse(row.at) + INVITATION_TTL_MS)
      .filter((deadline) => Number.isFinite(deadline) && deadline > now);
    await this.ctx.storage.setAlarm(Math.min(
      touchedAt + MAILBOX_IDLE_PURGE_MS,
      remainingDeadlines.length > 0 ? Math.min(...remainingDeadlines) : Infinity,
    ));
  }

  async verified(wave) {
    const stored = this.meta("waveHash");
    if (stored === null) return { status: 404, error: "no channel on this frequency" };
    if (typeof wave !== "string" || wave === "" || (await sha512Hex(wave)) !== stored) {
      return { status: 403, error: "wrong wave" };
    }
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      const { waveHash, mode } = await request.json();
      if (this.meta("waveHash") !== null) return json({ error: "taken" }, 409);
      this.sql.exec(
        "INSERT INTO meta (k, v) VALUES ('waveHash', ?), ('createdAt', ?), ('mode', ?)",
        waveHash,
        new Date(this.now()).toISOString(),
        mode === "mailbox" ? "mailbox" : "channel",
      );
      await this.alive();
      return json({ ok: true });
    }

    if (url.pathname === "/rotate") {
      if (this.meta("mode") !== "mailbox") return json({ error: "only station keys can rotate" }, 403);
      const { oldWave, newWaveHash } = await request.json();
      const refused = await this.verified(oldWave);
      if (refused) return json({ error: refused.error }, refused.status);
      if (typeof newWaveHash !== "string" || !/^[a-f0-9]{128}$/u.test(newWaveHash)) {
        return json({ error: "newWaveHash must be 128 hex characters" }, 400);
      }
      const oldWaveHash = await sha512Hex(oldWave);
      // Authorization may have yielded. Only the still-current old key may
      // commit a replacement; keep UPDATE and its row-count read synchronous.
      this.sql.exec("UPDATE meta SET v = ? WHERE k = 'waveHash' AND v = ?", newWaveHash, oldWaveHash);
      const changed = this.sql.exec("SELECT changes() AS n").toArray()[0]?.n;
      if (changed !== 1) return json({ error: "wrong wave" }, 403);
      await this.alive();
      return json({ ok: true });
    }

    if (url.pathname === "/send") {
      const { open, wave, from, text } = await request.json();
      if (open === true) {
        // An OPEN send is a CALL into a mailbox: a callsign is a phone
        // number, so anyone may write — but ONLY into a mailbox; a channel
        // never accepts an unkeyed word.
        if (this.meta("waveHash") === null) return json({ error: "no station with this callsign" }, 404);
        if (this.meta("mode") !== "mailbox") return json({ error: "channels accept no open sends" }, 403);
      } else {
        const refused = await this.verified(wave);
        if (refused) return json({ error: refused.error }, refused.status);
      }
      const at = new Date(this.now()).toISOString();
      this.sql.exec("INSERT INTO msgs (at, sender, body) VALUES (?, ?, ?)", at, from, text);
      const seq = this.sql.exec("SELECT MAX(seq) AS m FROM msgs").toArray()[0].m;
      this.sql.exec("DELETE FROM msgs WHERE seq <= ?", seq - KEEP_MESSAGES);
      await this.alive();
      return json({ seq });
    }

    if (url.pathname === "/messages") {
      const refused = await this.verified(request.headers.get("X-Wave") ?? "");
      if (refused) return json({ error: refused.error }, refused.status);
      // Reading your own mailbox IS your presence: the watch daemon polls it,
      // so "on air" is a fact about the daemon breathing, not a claim.
      if (this.meta("mode") === "mailbox") {
        this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('lastSeen', ?)", new Date(this.now()).toISOString());
      }
      const page = parsePageQuery(url.searchParams);
      if (!page) return json({ error: "since must be a canonical nonnegative safe integer and limit must be 1..200" }, 400);
      const rawRows = this.sql
        .exec("SELECT seq, at, sender, body FROM msgs WHERE seq > ? ORDER BY seq ASC LIMIT ?", page.since, KEEP_MESSAGES + 1)
        .toArray();
      const mailbox = this.meta("mode") === "mailbox";
      const now = this.now();
      const rows = rawRows.filter((row) => {
        if (!mailbox || !isInvitationText(row.body)) return true;
        const at = Date.parse(row.at);
        return !Number.isFinite(at) || now - at < INVITATION_TTL_MS;
      }).slice(0, page.limit + 1);
      const hasMore = rows.length > page.limit;
      const messages = rows.slice(0, page.limit).map((row) => ({ seq: row.seq, at: row.at, from: row.sender, text: row.body }));
      const last = hasMore
        ? messages[messages.length - 1].seq
        : (rawRows.length > 0 ? rawRows[rawRows.length - 1].seq : page.since);
      await this.alive();
      return json({ messages, last, nextSince: last, hasMore });
    }

    if (url.pathname === "/presence") {
      const registered = this.meta("waveHash") !== null && this.meta("mode") === "mailbox";
      if (!registered) return json({ registered: false }, 404);
      const lastSeen = this.meta("lastSeen");
      const onAir = lastSeen !== null && this.now() - Date.parse(lastSeen) < 90_000;
      return json({ registered: true, onAir, lastSeen });
    }

    return json({ error: "unknown internal call" }, 404);
  }
}
