#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const FORBIDDEN_NAMESPACE_IDS = new Set(["3101", "3102"]);

function limiterBlocks(text) {
  return [...text.matchAll(/\[\[(?:env\.staging\.)?ratelimits\]\]([\s\S]*?)(?=\n\[|$)/gu)].map((match) => match[1]);
}

export function checkAiradioDeploy({ workerSource, tomlText }) {
  const findings = [];
  const blocks = limiterBlocks(String(tomlText ?? ""));
  if (blocks.length === 0) findings.push("no AIRADIO rate limiter is bound");
  const ids = [];
  for (const block of blocks) {
    if (!/\bname\s*=\s*"AIRADIO_LIMITER"/u.test(block)) findings.push("a rate limiter binding is not named AIRADIO_LIMITER");
    const id = /\bnamespace_id\s*=\s*"(\d+)"/u.exec(block)?.[1];
    if (!id) findings.push("an AIRADIO limiter has no numeric namespace_id");
    else ids.push(id);
  }
  if (new Set(ids).size !== ids.length) findings.push("Airadio environments share a rate-limit namespace_id");
  for (const id of ids) {
    if (FORBIDDEN_NAMESPACE_IDS.has(id)) findings.push(`Airadio limiter namespace_id ${id} collides with MCP`);
  }
  const source = String(workerSource ?? "");
  if (!/env\.AIRADIO_LIMITER\.limit\s*\(/u.test(source)) findings.push("the Worker does not consult AIRADIO_LIMITER");
  return findings;
}

function main() {
  const tomlText = readFileSync(`${root}worker/wrangler.toml`, "utf8");
  const workerSource = readFileSync(`${root}worker/worker.mjs`, "utf8");
  const findings = checkAiradioDeploy({ workerSource, tomlText });
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`airadio deploy gate: ${finding}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("airadio deploy gate: limiter binding and Worker consultation verified\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
