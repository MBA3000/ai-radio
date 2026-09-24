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

test("pushes to main deploy only staging, after the tests, one deploy per target at a time", () => {
  const trigger = /^on:\n([\s\S]*?)\n\S/mu.exec(airadioWorkflow)?.[1] ?? "";
  assert.match(trigger, /^  push:\n    branches: \[main\]\n    paths-ignore:\n/mu, "a push to main is a trigger");
  assert.match(trigger, /^  workflow_dispatch:\n/mu, "production stays a hand dispatch");
  assert.doesNotMatch(trigger, /pull_request/u, "a pull request never deploys");
  const ignored = [...(/paths-ignore:\n((?: {6}- .+\n)+)/u.exec(trigger)?.[1] ?? "").matchAll(/- "(.+)"/gu)].map((match) => match[1]);
  assert.deepEqual(ignored, ["**.md", "docs/**", "LICENSE", ".env.example"], "only prose skips a deploy");
  // A push carries no inputs, so it can only ever resolve to staging.
  assert.match(airadioWorkflow, /TARGET_ENV:\s*\$\{\{\s*github\.event\.inputs\.environment\s*\|\|\s*'staging'\s*\}\}/u);
  assert.match(airadioWorkflow, /^concurrency:\n  group: deploy-\$\{\{ github\.event\.inputs\.environment \|\| 'staging' \}\}\n  cancel-in-progress: false$/mu);
  assert.match(airadioWorkflow, /^  deploy:\n    needs: test\n/mu, "nothing deploys before the tests pass");
  const testJob = /^  test:\n([\s\S]*)$/mu.exec(airadioWorkflow)?.[1] ?? "";
  for (const command of ["npm run airadio:gate", "npm run airadio:sync-daemon", "npm test"]) {
    assert.ok(testJob.includes(`run: ${command}`), `the deploy's test job runs ${command}`);
  }
});

test("deploys authenticate with this repository's scoped Cloudflare token, never the Global API Key", () => {
  assert.match(airadioWorkflow, /^      CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/mu);
  assert.match(airadioWorkflow, /^      CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}$/mu);
  assert.doesNotMatch(airadioWorkflow, /X-Auth-Key|X-Auth-Email|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|GLOBAL_API/u, "no Global API Key and no email+key pair");
  const verify = named(airadioSteps, "verify the credential");
  assert.ok(verify && index(airadioSteps, "verify the credential") < index(airadioSteps, "deploy the worker"));
  assert.match(verify.run, /-z "\$CLOUDFLARE_API_TOKEN"/u, "an unset token is refused locally");
  assert.match(verify.run, /-z "\$CLOUDFLARE_ACCOUNT_ID"/u, "an unset account is refused locally");
  assert.match(verify.run, /\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/tokens\/verify/u, "an account-owned token verifies at its account");
  assert.match(verify.run, /"\$STATUS" != "active"/u);
  const attach = named(airadioSteps, "attach airadio.akbrd.com");
  assert.equal(attach.if, "env.TARGET_ENV == 'production'");
  assert.ok(attach.run.indexOf("workers/domains?hostname=airadio.akbrd.com") < attach.run.indexOf("-X PUT"), "an attached domain is read before anything is written");
});

test("the Worker's entry exports only what the runtime runs, and the workflows are pinned and read-only", async () => {
  assert.match(wrangler, /^main = "entry\.mjs"$/mu, "wrangler deploys the entry module, not worker.mjs");
  const entry = await import(new URL("worker/entry.mjs", rootUrl));
  assert.deepEqual(Object.keys(entry).sort(), ["AiRadioChannel", "default"],
    "workerd (wrangler 4.138) refuses an entry export that is not a handler or a class, such as DAEMON_CODE");
  const worker = await import(new URL("worker/worker.mjs", rootUrl));
  assert.equal(entry.default, worker.default);
  assert.equal(entry.AiRadioChannel, worker.AiRadioChannel);
  assert.match(airadioWorkflow, /^permissions:\n  contents: read$/mu, "the deploy workflow's GITHUB_TOKEN only reads");
  assert.doesNotMatch(airadioWorkflow, /ubuntu-latest/u, "runners are pinned: ubuntu-latest moves to a new release on its own");
});
