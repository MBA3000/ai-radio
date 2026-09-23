#!/usr/bin/env node

// The station serves two programs byte-for-byte from the repository's
// runnable copies: GET /daemon.mjs (scripts/airadio-daemon.mjs, spliced into
// worker.mjs) and GET /radio.mjs (scripts/airadio-radio.mjs, generated as
// worker/radio-source.mjs). This script checks both, or rewrites them with
// --write. String.raw embedding is byte-exact only for sources that contain no
// backtick and no interpolation marker, so both are refused otherwise.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const daemonPath = `${root}/scripts/airadio-daemon.mjs`;
const workerPath = `${root}/worker/worker.mjs`;
const radioPath = `${root}/scripts/airadio-radio.mjs`;
const radioModulePath = `${root}/worker/radio-source.mjs`;
const marker = "export const DAEMON_CODE = String.raw`";
const endMarker = "`;\n\nconst MAX_TEXT_BYTES";

function refuseUnembeddable(name, source) {
  if (source.includes("`") || source.includes("${")) {
    throw new Error(`${name} source cannot be embedded in String.raw while it contains a backtick or interpolation marker`);
  }
}

export function embeddedWorkerSource(workerSource, daemonSource) {
  refuseUnembeddable("daemon", daemonSource);
  const start = workerSource.indexOf(marker);
  if (start < 0) throw new Error("worker daemon marker not found");
  const bodyStart = start + marker.length;
  const end = workerSource.indexOf(endMarker, bodyStart);
  if (end < 0) throw new Error("worker daemon end marker not found");
  return workerSource.slice(0, bodyStart) + daemonSource + workerSource.slice(end);
}

export function radioModuleSource(radioSource) {
  refuseUnembeddable("radio", radioSource);
  return "// GENERATED from scripts/airadio-radio.mjs by `npm run airadio:sync-daemon -- --write`.\n"
    + "// Do not edit: GET /radio.mjs serves these exact bytes.\n"
    + "export const RADIO_CODE = String.raw`" + radioSource + "`;\n";
}

function main() {
  const targets = [
    { path: workerPath, expected: embeddedWorkerSource(readFileSync(workerPath, "utf8"), readFileSync(daemonPath, "utf8")), name: "daemon" },
    { path: radioModulePath, expected: radioModuleSource(readFileSync(radioPath, "utf8")), name: "radio" },
  ];
  let stale = false;
  for (const target of targets) {
    let current = null;
    try { current = readFileSync(target.path, "utf8"); } catch {}
    if (current === target.expected) {
      process.stdout.write(`Airadio ${target.name} embedding is byte-equal.\n`);
    } else if (process.argv.includes("--write")) {
      writeFileSync(target.path, target.expected, "utf8");
      process.stdout.write(`Embedded Airadio ${target.name} byte-for-byte.\n`);
    } else {
      process.stderr.write(`Airadio ${target.name} embedding is stale; run npm run airadio:sync-daemon -- --write.\n`);
      stale = true;
    }
  }
  if (stale) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
