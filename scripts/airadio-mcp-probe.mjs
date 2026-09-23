#!/usr/bin/env node
/**
 * Safe Airadio probes.
 *
 * --local-selftest delegates to the canonical two-client test.
 * --canary is intentionally narrower: it accepts only an isolated preview
 * origin, creates one disposable channel, sends one nonce, and reads that same
 * channel. It contains no station/mailbox or delete operation.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const usage = "Usage: node scripts/airadio-mcp-probe.mjs --local-selftest\n" +
  "   or: node scripts/airadio-mcp-probe.mjs --canary --preview-url <origin> --channel-only [--allow-local-http]\n";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function previewOrigin(raw, allowLocalHttp) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("--preview-url must be an absolute URL"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--preview-url must be a bare origin without credentials, path, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (loopback && allowLocalHttp && url.protocol === "http:") return url.origin;
  if (url.protocol !== "https:") throw new Error("preview canary requires HTTPS (plain HTTP is loopback-test-only)");
  if (!url.hostname.startsWith("airadio-staging.") && !url.hostname.includes("preview")) {
    throw new Error("refusing non-preview Airadio origin");
  }
  return url.origin;
}

async function jsonRequest(origin, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(origin + path, { ...options, redirect: "error", signal: controller.signal });
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("response too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("response too large");
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("station returned invalid JSON"); }
    if (!response.ok) throw new Error("station returned HTTP " + response.status);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function runChannelCanary(origin) {
  const created = await jsonRequest(origin, "/v1/channel", { method: "POST" });
  if (!/^fm-[a-f0-9]{8,64}$/u.test(created?.frequency ?? "") || !/^[a-f0-9]{128}$/u.test(created?.wave ?? "")) {
    throw new Error("station returned an invalid disposable channel capability");
  }
  const nonce = "airadio-canary-" + randomUUID();
  const sent = await jsonRequest(origin, `/v1/channel/${created.frequency}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Wave": created.wave },
    body: JSON.stringify({ from: "deploy-canary", text: nonce }),
  });
  if (!Number.isSafeInteger(sent?.seq) || sent.seq < 1) throw new Error("canary send did not return a sequence");
  const received = await jsonRequest(origin, `/v1/channel/${created.frequency}/messages?since=0&limit=1`, {
    headers: { "X-Wave": created.wave },
  });
  const message = Array.isArray(received?.messages) ? received.messages.find((row) => row?.seq === sent.seq) : null;
  if (message?.text !== nonce || message?.from !== "deploy-canary") throw new Error("canary read-back did not match its own message");
  return { frequency: created.frequency, seq: sent.seq };
}

async function main() {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(usage);
    return;
  }
  if (args.length === 1 && args[0] === "--local-selftest") {
    const child = spawn("npm", ["test", "--", "test/airadio-mcp-interop.test.js"], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: "inherit",
    });
    const code = await new Promise((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (status) => resolve(status ?? 1));
    });
    process.exitCode = code;
    return;
  }
  const allowedCanaryArgs = new Set(["--canary", "--preview-url", "--channel-only", "--allow-local-http"]);
  const canary = args.includes("--canary") && args.includes("--channel-only") && valueAfter("--preview-url");
  const unknown = args.filter((arg, index) => index !== args.indexOf("--preview-url") + 1 && !allowedCanaryArgs.has(arg));
  if (!canary || unknown.length > 0) {
    process.stderr.write(`Refusing public or mutating probe mode. ${usage}`);
    process.exitCode = 2;
    return;
  }
  const origin = previewOrigin(valueAfter("--preview-url"), args.includes("--allow-local-http"));
  const result = await runChannelCanary(origin);
  process.stdout.write(`Airadio disposable channel canary passed (${result.frequency}, seq ${result.seq}); credential not printed.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Airadio canary failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
