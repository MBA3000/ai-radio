#!/usr/bin/env node

// The station serves programs and images built from this repository's
// sources, and this script keeps them from drifting (check), or rebuilds them
// (--write):
//   GET /daemon.mjs  scripts/airadio-daemon.mjs, spliced into worker.mjs
//   GET /radio.mjs   scripts/airadio-radio.mjs, generated as worker/radio-source.mjs
//   GET /icon-*.png  worker/icon.mjs, rendered into worker/icons.generated.mjs
// Programs are embedded byte for byte with String.raw, so they may contain no
// backtick and no interpolation marker. Icons are prebuilt because rendering
// one costs more CPU than a free-plan request gets; they are compared by
// pixels, since zlib builds may compress the same pixels differently.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const daemonPath = `${root}/scripts/airadio-daemon.mjs`;
const workerPath = `${root}/worker/worker.mjs`;
const radioPath = `${root}/scripts/airadio-radio.mjs`;
const radioModulePath = `${root}/worker/radio-source.mjs`;
const iconsModulePath = `${root}/worker/icons.generated.mjs`;
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

/** Width, height and RGB rows of a PNG this repository wrote (8-bit RGB, filter 0). */
export function pngPixels(png) {
  const bytes = Buffer.from(png);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 2) throw new Error("expected 8-bit RGB");
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = 1 + width * 3;
  if (raw.length !== height * stride) throw new Error("wrong image size");
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * stride] !== 0) throw new Error("unexpected PNG filter");
    raw.copy(rgb, y * width * 3, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, rgb };
}

/** True when two renders agree to within one level per channel (last-bit float differences between engines). */
export function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (Math.abs(a[index] - b[index]) > 1) return false;
  return true;
}

async function iconRenderer() {
  return import(pathToFileURL(`${root}/worker/icon.mjs`).href);
}

export async function iconsModuleSource() {
  const { ICONS, iconPng } = await iconRenderer();
  const lines = [];
  for (const path of Object.keys(ICONS)) {
    lines.push("  " + JSON.stringify(path) + ": " + JSON.stringify(Buffer.from(await iconPng(path)).toString("base64")) + ",");
  }
  return "// GENERATED from worker/icon.mjs by `npm run airadio:sync-daemon -- --write`.\n"
    + "// Do not edit: the station serves these PNGs (base64) at the same paths.\n"
    + "export const ICON_PNGS = Object.freeze({\n" + lines.join("\n") + "\n});\n";
}

export async function iconsCurrent() {
  const { ICONS, iconPixels } = await iconRenderer();
  let module;
  try {
    module = await import(pathToFileURL(iconsModulePath).href + "?check=" + Date.now());
  } catch {
    return false;
  }
  const served = module.ICON_PNGS || {};
  if (Object.keys(served).sort().join() !== Object.keys(ICONS).sort().join()) return false;
  for (const [path, spec] of Object.entries(ICONS)) {
    let image;
    try {
      image = pngPixels(Buffer.from(served[path], "base64"));
    } catch {
      return false;
    }
    if (image.width !== spec.size || image.height !== spec.size || !samePixels(image.rgb, iconPixels(spec.size, spec))) return false;
  }
  return true;
}

async function main() {
  const write = process.argv.includes("--write");
  let stale = false;
  const report = (name, current, rebuild) => {
    if (current) {
      process.stdout.write(`Airadio ${name} embedding is current.\n`);
    } else if (write) {
      rebuild();
      process.stdout.write(`Rebuilt the Airadio ${name} embedding.\n`);
    } else {
      process.stderr.write(`Airadio ${name} embedding is stale; run npm run airadio:sync-daemon -- --write.\n`);
      stale = true;
    }
  };
  const read = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const worker = embeddedWorkerSource(readFileSync(workerPath, "utf8"), readFileSync(daemonPath, "utf8"));
  report("daemon", read(workerPath) === worker, () => writeFileSync(workerPath, worker, "utf8"));
  const radio = radioModuleSource(readFileSync(radioPath, "utf8"));
  report("radio", read(radioModulePath) === radio, () => writeFileSync(radioModulePath, radio, "utf8"));
  const icons = await iconsCurrent();
  const iconsSource = icons ? null : await iconsModuleSource();
  report("icons", icons, () => writeFileSync(iconsModulePath, iconsSource, "utf8"));
  if (stale) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
