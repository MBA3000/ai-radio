import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);
const airadioWorkflow = readFileSync(new URL(".github/workflows/deploy.yml", rootUrl), "utf8");
const wrangler = readFileSync(new URL("worker/wrangler.toml", rootUrl), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("package.json", rootUrl), "utf8"));

function parseSteps(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s{4}steps:\s*$/.test(line));
  assert.notEqual(start, -1, "steps block is required");
  const steps = [];
  let current = null;
  let inRun = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const next = /^ {6}- (uses|name):\s*(.*)$/.exec(line);
    if (next) {
      if (current) steps.push(current);
      current = { name: null, uses: null, if: null, run: "", raw: `${line}\n` };
      current[next[1]] = next[2].replace(/^(["'])(.*)\1$/u, "$2");
      inRun = false;
      continue;
    }
    if (!current) continue;
    if (/^ {8}run:\s*\|[-+]?\s*$/.test(line)) {
      inRun = true;
      current.raw += `${line}\n`;
      continue;
    }
    const inlineRun = /^ {8}run:\s*(.+)$/.exec(line);
    if (inlineRun) {
      current.run = inlineRun[1];
      inRun = false;
      current.raw += `${line}\n`;
      continue;
    }
    const scalar = /^ {8}(if):\s*(.*)$/.exec(line);
    if (scalar) {
      current[scalar[1]] = scalar[2].replace(/^(["'])(.*)\1$/u, "$2");
      inRun = false;
      current.raw += `${line}\n`;
      continue;
    }
    if (inRun && (/^ {10}/.test(line) || line.trim() === "")) current.run += `${line}\n`;
    current.raw += `${line}\n`;
    if (/^ {4}\S/.test(line)) break;
  }
  if (current) steps.push(current);
  return steps;
}

const airadioSteps = parseSteps(airadioWorkflow);
const named = (steps, fragment) => steps.find((step) => step.name?.includes(fragment));
const index = (steps, fragment) => steps.findIndex((step) => step.name?.includes(fragment));

test("Airadio wrangler binds isolated production and staging rate-limit namespaces", () => {
  const ids = [...wrangler.matchAll(/namespace_id\s*=\s*"(\d+)"/gu)].map((match) => match[1]);
  assert.deepEqual(ids, ["3103", "3104"]);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids.some((id) => id === "3101" || id === "3102"), false, "Airadio cannot share MCP limiter state");
  assert.match(wrangler, /\[\[ratelimits\]\][\s\S]*?name\s*=\s*"AIRADIO_LIMITER"/u);
  assert.match(wrangler, /\[\[env\.staging\.ratelimits\]\][\s\S]*?name\s*=\s*"AIRADIO_LIMITER"/u);
  assert.match(wrangler, /\[env\.staging\][\s\S]*?name\s*=\s*"airadio-staging"/u);
});

test("the Airadio deploy gate is a package door and rejects missing limiter/consultation", async () => {
  assert.equal(packageJson.scripts["airadio:gate"], "node scripts/airadio-deploy-gate.mjs");
  const gate = await import("../scripts/airadio-deploy-gate.mjs").catch(() => ({}));
  assert.equal(typeof gate.checkAiradioDeploy, "function");
  const worker = 'await env.AIRADIO_LIMITER.limit({ key: "x" });';
  const config = '[[ratelimits]]\nname = "AIRADIO_LIMITER"\nnamespace_id = "3103"\n[ratelimits.simple]\nlimit = 30\nperiod = 60\n';
  assert.deepEqual(gate.checkAiradioDeploy({ workerSource: worker, tomlText: config }), []);
  assert.ok(gate.checkAiradioDeploy({ workerSource: worker, tomlText: "" }).some((finding) => /limiter/u.test(finding)));
  assert.ok(gate.checkAiradioDeploy({ workerSource: "export default {};", tomlText: config }).some((finding) => /consult/u.test(finding)));
});

test("Airadio deploy is staging by default, stamps health, reads it back, then runs only a channel-only preview canary", () => {
  assert.match(airadioWorkflow, /TARGET_ENV:\s*\$\{\{\s*github\.event\.inputs\.environment\s*\|\|\s*'staging'\s*\}\}/u);
  const gate = named(airadioSteps, "refuse an unthrottled surface");
  const deploy = named(airadioSteps, "deploy the worker");
  const readback = named(airadioSteps, "read back the deployed build SHA");
  const canary = named(airadioSteps, "disposable preview channel canary");
  assert.ok(gate && deploy && readback && canary);
  assert.ok(index(airadioSteps, "refuse an unthrottled surface") < index(airadioSteps, "deploy the worker"));
  assert.ok(index(airadioSteps, "deploy the worker") < index(airadioSteps, "read back the deployed build SHA"));
  assert.ok(index(airadioSteps, "read back the deployed build SHA") < index(airadioSteps, "disposable preview channel canary"));
  assert.match(deploy.run, /--var GIT_SHA:\$GITHUB_SHA/u);
  assert.match(readback.run, /\/health/u);
  assert.match(readback.run, /\.sha\s*==\s*\$sha/u);
  assert.match(readback.run, /exit 1/u);
  assert.equal(canary.if, "env.TARGET_ENV == 'staging'");
  assert.match(canary.run, /airadio-mcp-probe\.mjs --canary --preview-url "\$AIRADIO_BASE" --channel-only/u);
  assert.doesNotMatch(canary.run, /\/v1\/station|villa|mailbox|purge/iu);
});
