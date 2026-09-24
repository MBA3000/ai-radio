/**
 * The receiver outlives the service that started it.
 *
 * Seen live on 2026-09-24: an agent hosted by the Hermes gateway (a systemd
 * user service) started its receiver from inside that service. setsid leaves
 * the process group but not the cgroup, and every gateway restart killed the
 * receiver with the rest of the service, so the agent fell off the air at
 * every restart. The radio now notices a foreign service around it and hands
 * the receiver to the user's systemd as a unit of its own. Everything here is
 * injected, so no test ever creates a real systemd unit.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureReceiver, hostService, radioPaths, receiverPid, receiverUnit, systemdRunArgs, systemdRunPath } from "../scripts/airadio-radio.mjs";
import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";

const RADIO = fileURLToPath(new URL("../scripts/airadio-radio.mjs", import.meta.url));
const ENV = { ...process.env, AIRADIO_SYSTEMD: "0" };

function radio(home, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [RADIO, ...args, "--home", home], { timeout: 30_000, env: ENV }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function channel(station) {
  const response = await fetch(station.url + "/v1/channel", { method: "POST" });
  const body = await response.json();
  return { frequency: body.frequency, key: body.wave };
}

test("the host service is read from the cgroup, and only a foreign service counts", () => {
  const host = (text) => hostService({ read: () => text, env: {} });
  assert.equal(host("0::/user.slice/user-1000.slice/user@1000.service/app.slice/hermes-gateway.service\n"), "hermes-gateway.service");
  assert.equal(host("0::/system.slice/cron.service\n"), "cron.service");
  assert.equal(host("12:pids:/x\n1:name=systemd:/system.slice/agent-host.service\n"), "agent-host.service", "cgroup v1 names the service too");
  assert.equal(host("0::/init.scope\n"), null, "a WSL or container init is nobody's service");
  assert.equal(host("0::/user.slice/user-1000.slice/session-3.scope\n"), null, "a login session is not a service");
  assert.equal(host("0::/user.slice/user-1000.slice/user@1000.service\n"), null, "the user manager itself is not a host");
  assert.equal(host("0::/user.slice/user-1000.slice/user@1000.service/app.slice/airadio-solnze.service\n"), null, "a receiver's own unit is not escaped from");
  assert.equal(hostService({ read: () => { throw new Error("no /proc"); }, env: {} }), null);
  assert.equal(hostService({ read: () => "0::/system.slice/cron.service\n", env: { AIRADIO_SYSTEMD: "0" } }), null, "AIRADIO_SYSTEMD=0 turns the hand-off off");
});

test("systemd-run is used only when a user manager is there to take the unit", () => {
  const files = new Set(["/run/user/1000/systemd/private", "/usr/bin/systemd-run"]);
  const exists = (file) => files.has(file);
  assert.equal(systemdRunPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/local/bin:/usr/bin" }, exists }), "/usr/bin/systemd-run");
  assert.equal(systemdRunPath({ env: { PATH: "/usr/bin" }, exists }), null, "no runtime dir, no user manager");
  assert.equal(systemdRunPath({ env: { XDG_RUNTIME_DIR: "/run/user/2000", PATH: "/usr/bin" }, exists }), null, "no manager socket");
  assert.equal(systemdRunPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/opt/bin" }, exists }), null, "no systemd-run on PATH");
  assert.equal(systemdRunPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin", AIRADIO_SYSTEMD: "0" }, exists }), null);
});

test("the unit is named per radio home and its command line carries nothing secret", () => {
  const a = radioPaths("/home/x/.airadio");
  const b = radioPaths("/home/x/.hermes/profiles/solnze/airadio");
  assert.match(receiverUnit(a), /^airadio-radio-[0-9a-f]{12}$/u);
  assert.notEqual(receiverUnit(a), receiverUnit(b), "two homes never share a unit");
  assert.equal(receiverUnit(a), receiverUnit(radioPaths("/home/x/.airadio")), "the same home always gets the same unit");
  const args = systemdRunArgs(b, { node: "/usr/bin/node", script: b.program, unit: "airadio-radio-0123456789ab" });
  assert.deepEqual(args, [
    "--user", "--unit=airadio-radio-0123456789ab", "--description=AI RADIO receiver", "--collect", "--quiet",
    "--property=Restart=on-failure", "--property=RestartSec=15",
    "--property=StandardOutput=append:" + b.log, "--property=StandardError=append:" + b.log,
    "--setenv=AIRADIO_HOME=" + b.home, "--working-directory=" + b.home,
    "--", "/usr/bin/node", b.program, "run",
  ]);
  assert.ok(!args.some((arg) => /[0-9a-f]{64}|fm-/u.test(arg)), "no key and no frequency: systemd keeps the command line and the description");
});

test("inside a foreign service the receiver is handed to systemd, and stop stops that unit", { timeout: 60_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const home = mkdtempSync(join(tmpdir(), "airadio-lifetime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { frequency, key } = await channel(station);
  const tuned = await radio(home, ["tune", station.url, frequency, key, "--as", "hosted"]);
  assert.equal(tuned.code, 0, tuned.stderr);
  assert.equal((await radio(home, ["stop", "--operator-asked"])).code, 0);

  const p = radioPaths(home);
  const calls = [];
  // Stands in for systemd: it starts the same "run" command systemd would.
  const runner = (bin, args) => {
    calls.push([bin, args]);
    if (bin.endsWith("systemd-run")) {
      const child = spawn(process.execPath, [args[args.length - 2], "run"], { detached: true, stdio: "ignore", env: { ...ENV, AIRADIO_HOME: home } });
      child.unref();
    }
    return { status: 0 };
  };
  const started = await ensureReceiver(p, { host: "hermes-gateway.service", systemd: "/usr/bin/systemd-run", runner });
  assert.equal(started.started, true);
  assert.equal(started.unit, receiverUnit(p) + ".service");
  assert.equal(started.host, null, "handed to systemd, so no service can take it down");
  assert.equal(readFileSync(p.unit, "utf8").trim(), receiverUnit(p) + ".service", "the unit is remembered for stop and status");
  assert.deepEqual(calls[0], ["/usr/bin/systemctl", ["--user", "reset-failed", receiverUnit(p) + ".service"]], "a failed leftover of the same name is cleared first");
  assert.deepEqual(calls[1], ["/usr/bin/systemd-run", systemdRunArgs(p, { script: p.program, unit: receiverUnit(p) })]);

  const status = JSON.parse((await radio(home, ["status", "--json", "--offline"])).stdout);
  assert.equal(status.unit, receiverUnit(p) + ".service");
  const stopped = await radio(home, ["stop", "--operator-asked"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(existsSync(p.unit), false, "stop forgets the unit");
  assert.equal(receiverPid(p), null);
});

test("when systemd cannot take it, the receiver still starts, and the agent is warned", { timeout: 60_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const home = mkdtempSync(join(tmpdir(), "airadio-lifetime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { frequency, key } = await channel(station);
  assert.equal((await radio(home, ["tune", station.url, frequency, key, "--as", "hosted"])).code, 0);
  assert.equal((await radio(home, ["stop", "--operator-asked"])).code, 0);

  const p = radioPaths(home);
  const started = await ensureReceiver(p, { host: "hermes-gateway.service", systemd: "/usr/bin/systemd-run", runner: () => ({ status: 1 }) });
  t.after(() => radio(home, ["stop", "--operator-asked"]));
  assert.equal(started.started, true, "a detached receiver is better than none");
  assert.equal(started.unit, null);
  assert.equal(started.host, "hermes-gateway.service", "the caller is told where the receiver is stuck");
  assert.equal(existsSync(p.unit), false);
});

test("tune takes the key from stdin, so it never sits in argv", { timeout: 60_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const home = mkdtempSync(join(tmpdir(), "airadio-lifetime-"));
  t.after(async () => { await radio(home, ["stop", "--operator-asked"]); rmSync(home, { recursive: true, force: true }); });
  const { frequency, key } = await channel(station);
  const tuned = await radio(home, ["tune", station.url, frequency, "-", "--as", "quiet"], { input: key + "\n" });
  assert.equal(tuned.code, 0, tuned.stderr);
  assert.match(tuned.stdout, /ON THE AIR/u);
  assert.equal(JSON.parse(readFileSync(radioPaths(home).config, "utf8")).channels[frequency].key, key);

  const empty = await radio(home, ["tune", station.url, frequency, "-", "--as", "quiet"], { input: "" });
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /the key must be the hexadecimal KEY/u);
});
