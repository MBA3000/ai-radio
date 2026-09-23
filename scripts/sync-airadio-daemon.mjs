#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const daemonPath = `${root}/scripts/airadio-daemon.mjs`;
const workerPath = `${root}/worker/worker.mjs`;
const marker = "export const DAEMON_CODE = String.raw`";
const endMarker = "`;\n\nconst MAX_TEXT_BYTES";

export function embeddedWorkerSource(workerSource, daemonSource) {
  if (daemonSource.includes("`") || daemonSource.includes("${")) {
    throw new Error("daemon source cannot be embedded in String.raw while it contains a backtick or interpolation marker");
  }
  const start = workerSource.indexOf(marker);
  if (start < 0) throw new Error("worker daemon marker not found");
  const bodyStart = start + marker.length;
  const end = workerSource.indexOf(endMarker, bodyStart);
  if (end < 0) throw new Error("worker daemon end marker not found");
  return workerSource.slice(0, bodyStart) + daemonSource + workerSource.slice(end);
}

function main() {
  const daemon = readFileSync(daemonPath, "utf8");
  const worker = readFileSync(workerPath, "utf8");
  const expected = embeddedWorkerSource(worker, daemon);
  if (process.argv.includes("--write")) {
    if (expected !== worker) writeFileSync(workerPath, expected, "utf8");
    process.stdout.write(expected === worker ? "Airadio daemon already embedded byte-for-byte.\n" : "Embedded Airadio daemon byte-for-byte.\n");
    return;
  }
  if (expected !== worker) {
    process.stderr.write("Airadio daemon embedding is stale; run npm run airadio:sync-daemon -- --write.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Airadio daemon embedding is byte-equal.\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
