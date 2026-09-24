/**
 * The Airadio MCP adapter's PRIVATE credential store.
 *
 * A station key and a channel wave are the only two secrets in the AI RADIO
 * protocol, and the adapter is the only thing that may hold them. They live
 * OUTSIDE the repository and outside `.kofe`, in an operator-chosen absolute
 * file, because a secret inside a working tree is one `git add -A` away from a
 * remote. This file pins the properties that make that store safe to reuse:
 * mode 0600, atomic replacement, refusal of a symlinked or shared-inode target,
 * a single-writer lock, origin binding, and read-modify-write under the lock so
 * a second save cannot silently drop the first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiradioStateError, openAiradioState } from "../src/airadio-state.js";

const ORIGIN = "https://airadio.akbrd.com";
const OTHER_ORIGIN = "https://airadio.example.org";
const KEY = "a".repeat(128);
const WAVE = "b".repeat(128);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "airadio-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a fresh store reports nothing and writes nothing until something is saved", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    assert.equal(store.station(), null);
    assert.equal(store.stationKey(), null);
    assert.deepEqual(store.channels(), []);
    assert.deepEqual(store.secrets(), []);
    assert.equal(existsSync(path), false, "opening a store must not create a file");
  } finally {
    store.close();
  }
});

test("a saved station is private: mode 0600, no temp file left, and the key is never in the public view", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveStation("alpha-one", KEY);
    assert.deepEqual(store.station(), { callsign: "alpha-one", origin: ORIGIN });
    assert.equal(store.stationKey(), KEY);
    assert.deepEqual(store.secrets(), [KEY]);

    const mode = lstatSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `the state file must be 0600, saw ${mode.toString(8)}`);

    const leftovers = readdirSync(dir).filter((name) => name !== "state.json" && !name.endsWith(".lock"));
    assert.deepEqual(leftovers, [], "an atomic write leaves no temp file behind");

    const raw = readFileSync(path, "utf8");
    assert.ok(raw.includes(KEY), "the key is stored (privately) — that is the point of the file");
  } finally {
    store.close();
  }
});

test("channels are saved with their wave and survive a restart of the process", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const first = openAiradioState({ path, origin: ORIGIN });
  try {
    first.saveStation("alpha-one", KEY);
    first.saveChannel("fm-abcdef0123456789", WAVE, { role: "created" });
  } finally {
    first.close();
  }

  const second = openAiradioState({ path, origin: ORIGIN });
  try {
    assert.deepEqual(second.station(), { callsign: "alpha-one", origin: ORIGIN });
    assert.equal(second.stationKey(), KEY);
    assert.deepEqual(second.channels(), ["fm-abcdef0123456789"]);
    assert.equal(second.channelWave("fm-abcdef0123456789"), WAVE);
    assert.equal(second.channelWave("fm-0000000000000000"), null);
    assert.deepEqual(second.secrets().sort(), [KEY, WAVE].sort());
  } finally {
    second.close();
  }
});

test("state binds to its origin: credentials minted for one station are invisible at another", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const home = openAiradioState({ path, origin: ORIGIN });
  try {
    home.saveStation("alpha-one", KEY);
    home.saveChannel("fm-abcdef0123456789", WAVE);
  } finally {
    home.close();
  }

  const elsewhere = openAiradioState({ path, origin: OTHER_ORIGIN });
  try {
    assert.equal(elsewhere.station(), null, "a key minted at one origin must not be offered to another");
    assert.equal(elsewhere.stationKey(), null);
    assert.deepEqual(elsewhere.channels(), []);
    assert.equal(elsewhere.channelWave("fm-abcdef0123456789"), null);
    assert.deepEqual(elsewhere.secrets(), [], "another origin's secrets are not even loaded for redaction");
  } finally {
    elsewhere.close();
  }

  // And the other origin's own registration does not destroy the first one.
  const again = openAiradioState({ path, origin: OTHER_ORIGIN });
  try {
    again.saveStation("beta-two", "c".repeat(128));
  } finally {
    again.close();
  }
  const back = openAiradioState({ path, origin: ORIGIN });
  try {
    assert.deepEqual(back.station(), { callsign: "alpha-one", origin: ORIGIN });
    assert.equal(back.channelWave("fm-abcdef0123456789"), WAVE);
  } finally {
    back.close();
  }
});

test("a save re-reads under the lock, so a concurrent writer's row is not lost", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveStation("alpha-one", KEY);

    // Someone else (a previous adapter run, a restore) appends a channel to the
    // very same file while this process holds an older in-memory snapshot.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.origins[ORIGIN].channels["fm-1111111111111111"] = { wave: "d".repeat(128) };
    writeFileSync(path, `${JSON.stringify(onDisk)}\n`, { mode: 0o600 });

    store.saveChannel("fm-2222222222222222", WAVE);
    const merged = JSON.parse(readFileSync(path, "utf8")).origins[ORIGIN].channels;
    assert.deepEqual(Object.keys(merged).sort(), ["fm-1111111111111111", "fm-2222222222222222"]);
  } finally {
    store.close();
  }
});

test("two adapters cannot hold the same state file at once", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const first = openAiradioState({ path, origin: ORIGIN });
  try {
    assert.throws(
      () => openAiradioState({ path, origin: ORIGIN }),
      (error) => error instanceof AiradioStateError && error.code === "locked",
      "a second adapter on the same state file must fail closed",
    );
  } finally {
    first.close();
  }
  // Once released, the file is openable again.
  const second = openAiradioState({ path, origin: ORIGIN });
  second.close();
});

test("a stale lock from a dead process is reclaimed rather than blocking forever", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }), { mode: 0o600 });
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveStation("alpha-one", KEY);
    assert.equal(store.stationKey(), KEY);
  } finally {
    store.close();
  }
});

test("an unsafe state file is refused: a symlink, a shared inode, or loose permissions", (t) => {
  const dir = scratch(t);

  const target = join(dir, "real.json");
  writeFileSync(target, "{}\n", { mode: 0o600 });
  const link = join(dir, "linked.json");
  symlinkSync(target, link);
  assert.throws(
    () => openAiradioState({ path: link, origin: ORIGIN }),
    (error) => error instanceof AiradioStateError && error.code === "unsafe-state-file",
    "a symlinked state file could point anywhere",
  );

  const hard = join(dir, "hard.json");
  linkSync(target, hard);
  assert.throws(
    () => openAiradioState({ path: hard, origin: ORIGIN }),
    (error) => error instanceof AiradioStateError && error.code === "unsafe-state-file",
    "a second name for the same inode is a second reader",
  );

  const loose = join(dir, "loose.json");
  writeFileSync(loose, "{}\n", { mode: 0o600 });
  chmodSync(loose, 0o644);
  assert.throws(
    () => openAiradioState({ path: loose, origin: ORIGIN }),
    (error) => error instanceof AiradioStateError && error.code === "unsafe-state-file",
    "a group- or world-readable state file is not private",
  );
});

test("the state path must be absolute, and a corrupt file fails closed rather than silently emptying", (t) => {
  const dir = scratch(t);
  assert.throws(
    () => openAiradioState({ path: "relative/state.json", origin: ORIGIN }),
    (error) => error instanceof AiradioStateError && error.code === "state-path",
  );

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json at all", { mode: 0o600 });
  assert.throws(
    () => openAiradioState({ path: broken, origin: ORIGIN }),
    (error) => error instanceof AiradioStateError && error.code === "unreadable-state",
    "a corrupt store must be reported, never treated as 'no credentials yet'",
  );
});

test("only an absent state file is fresh: empty, versionless, and unsupported documents fail without rewriting bytes", (t) => {
  const dir = scratch(t);
  const cases = [
    ["empty", ""],
    ["whitespace", " \n\t  \n"],
    ["versionless", JSON.stringify({ origins: {} })],
    ["unsupported-version", JSON.stringify({ version: 2, origins: {} })],
    ["string-version", JSON.stringify({ version: "1", origins: {} })],
  ];

  for (const [name, raw] of cases) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, raw, { mode: 0o600 });
    const before = readFileSync(path, "utf8");
    assert.throws(
      () => openAiradioState({ path, origin: ORIGIN }),
      (error) => error instanceof AiradioStateError
        && error.code === "unreadable-state"
        && !error.message.includes(path)
        && !error.message.includes(KEY),
      `${name} must fail with a sanitized unreadable-state error`,
    );
    assert.equal(readFileSync(path, "utf8"), before, `${name} bytes must remain intact`);
    assert.equal(existsSync(`${path}.lock`), false, `${name} failure must release only its own lock`);
  }
});

test("every stored origin bucket and public credential shape is validated before it can be read or merged", (t) => {
  const dir = scratch(t);
  const validBucket = {
    station: { callsign: "alpha-one", registeredAt: "2026-09-09T00:00:00.000Z" },
    key: KEY,
    channels: { "fm-abcdef0123456789": { wave: WAVE, savedAt: "2026-09-09T00:00:00.000Z" } },
  };
  const cases = [
    ["null-bucket", { [ORIGIN]: null }],
    ["incomplete-bucket", { [ORIGIN]: {} }],
    ["bad-callsign", { [ORIGIN]: { ...validBucket, station: { ...validBucket.station, callsign: "UPPER" } } }],
    ["bad-station-key", { [ORIGIN]: { ...validBucket, key: "not-a-credential" } }],
    ["bad-channel-id", { [ORIGIN]: { ...validBucket, channels: { "fm-NOT-HEX": { wave: WAVE, savedAt: "2026-09-09T00:00:00.000Z" } } } }],
    ["bad-channel-wave", { [ORIGIN]: { ...validBucket, channels: { "fm-abcdef0123456789": { wave: "short", savedAt: "2026-09-09T00:00:00.000Z" } } } }],
    ["bad-channel-entry", { [ORIGIN]: { ...validBucket, channels: { "fm-abcdef0123456789": null } } }],
    ["bad-other-origin-bucket", { [ORIGIN]: validBucket, [OTHER_ORIGIN]: { station: null, key: null, channels: "not-an-object" } }],
  ];

  for (const [name, origins] of cases) {
    const path = join(dir, `${name}.json`);
    const raw = `${JSON.stringify({ version: 1, origins })}\n`;
    writeFileSync(path, raw, { mode: 0o600 });
    assert.throws(
      () => openAiradioState({ path, origin: ORIGIN }),
      (error) => error instanceof AiradioStateError
        && error.code === "unreadable-state"
        && !error.message.includes(path)
        && !error.message.includes(KEY),
      `${name} must not be normalized into an empty bucket`,
    );
    assert.equal(readFileSync(path, "utf8"), raw, `${name} bytes must remain intact`);
  }
});

test("public identifiers and credentials are rejected before any save can change the document", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveStation("alpha-one", KEY);
    const before = readFileSync(path, "utf8");
    for (const [label, action] of [
      ["bad callsign", () => store.saveStation("UPPER", KEY)],
      ["short station key", () => store.saveStation("alpha-one", "a".repeat(15))],
      ["non-hex station key", () => store.saveStation("alpha-one", "g".repeat(16))],
      ["bad channel id", () => store.saveChannel("fm-NOT-HEX", WAVE)],
      ["short channel wave", () => store.saveChannel("fm-abcdef0123456789", "b".repeat(15))],
      ["non-hex channel wave", () => store.saveChannel("fm-abcdef0123456789", "g".repeat(16))],
    ]) {
      assert.throws(
        action,
        (error) => error instanceof AiradioStateError,
        `${label} must fail as a state error`,
      );
      assert.equal(readFileSync(path, "utf8"), before, `${label} must not rewrite the state`);
    }
  } finally {
    store.close();
  }
});

test("an in-progress lock is indeterminate and is never reclaimed while its owner publishes", async (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const lockPath = `${path}.lock`;
  const childSource = `
    import { closeSync, openSync, writeSync } from "node:fs";
    const fd = openSync(process.env.AIRADIO_TEST_LOCK, "wx", 0o600);
    process.stdout.write("created\\n");
    process.stdin.once("data", () => {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "child-owner" }));
      closeSync(fd);
      process.stdout.write("published\\n");
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    env: { AIRADIO_TEST_LOCK: lockPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill();
    rmSync(lockPath, { force: true });
  });

  const [created] = await once(child.stdout, "data");
  assert.match(created.toString(), /created/u);
  assert.throws(
    () => openAiradioState({ path, origin: ORIGIN }),
    (error) => error instanceof AiradioStateError && error.code === "locked",
    "a second start must refuse an empty publication-window lock",
  );
  assert.equal(readFileSync(lockPath, "utf8"), "", "the indeterminate lock must be preserved byte-for-byte");

  child.stdin.end("publish\\n");
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0, "the publishing fixture must exit cleanly");
  const published = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(published.token, "child-owner");
});

test("close releases only its own lock, preserving same-inode and replacement-lock ownership", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const lockPath = `${path}.lock`;
  const replacement = JSON.stringify({ pid: process.pid, at: "replacement", token: "other-owner" });

  const first = openAiradioState({ path, origin: ORIGIN });
  try {
    writeFileSync(lockPath, replacement, { mode: 0o600 });
    first.close();
    assert.equal(readFileSync(lockPath, "utf8"), replacement, "a same-inode replacement must survive close");
  } finally {
    rmSync(lockPath, { force: true });
  }

  const second = openAiradioState({ path, origin: ORIGIN });
  try {
    rmSync(lockPath);
    writeFileSync(lockPath, replacement, { mode: 0o600 });
    second.close();
    assert.equal(readFileSync(lockPath, "utf8"), replacement, "a new-inode replacement must survive close");
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test("malformed locks are indeterminate and remain in place", (t) => {
  const dir = scratch(t);
  const cases = [
    ["malformed-json", "not json"],
    ["string-pid", JSON.stringify({ pid: "2147483646", at: "2026-09-09T00:00:00.000Z" })],
    ["zero-pid", JSON.stringify({ pid: 0, at: "2026-09-09T00:00:00.000Z" })],
    ["missing-at", JSON.stringify({ pid: 2147483646 })],
  ];
  for (const [name, raw] of cases) {
    const path = join(dir, `${name}.json`);
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, raw, { mode: 0o600 });
    assert.throws(
      () => openAiradioState({ path, origin: ORIGIN }),
      (error) => error instanceof AiradioStateError && error.code === "locked",
      `${name} must be indeterminate, never assumed dead`,
    );
    assert.equal(readFileSync(lockPath, "utf8"), raw, `${name} lock must remain untouched`);
  }
});

test("the store creates its parent directory privately when the operator names a fresh path", (t) => {
  const dir = scratch(t);
  const path = join(dir, "nested", "deeper", "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveStation("alpha-one", KEY);
  } finally {
    store.close();
  }
  assert.equal(lstatSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
});

test("a station is not silently replaced by a different identity", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveStation("alpha-one", KEY);
    assert.throws(
      () => store.saveStation("beta-two", "c".repeat(128)),
      (error) => error instanceof AiradioStateError && error.code === "identity-conflict",
      "overwriting a registered identity loses the only copy of its key",
    );
    // Re-saving the SAME callsign (a re-registration after a refusal) is allowed.
    store.saveStation("alpha-one", "e".repeat(128));
    assert.equal(store.stationKey(), "e".repeat(128));
  } finally {
    store.close();
  }
});

test("a channel's wave is not silently replaced by a different one", (t) => {
  const dir = scratch(t);
  const path = join(dir, "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveChannel("fm-abcdef0123456789", WAVE, { role: "created" });
    assert.throws(
      () => store.saveChannel("fm-abcdef0123456789", "c".repeat(128), { role: "accepted" }),
      (error) => error instanceof AiradioStateError && error.code === "channel-conflict",
      "a channel has one wave for life; overwriting it loses the only copy that works",
    );
    assert.equal(store.channelWave("fm-abcdef0123456789"), WAVE);
    // The same wave again is harmless and still allowed.
    store.saveChannel("fm-abcdef0123456789", WAVE, { role: "accepted" });
    assert.equal(store.channelWave("fm-abcdef0123456789"), WAVE);
  } finally {
    store.close();
  }
});

test("mkdirSync of the parent is not required when it already exists", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "here"), { recursive: true, mode: 0o700 });
  const path = join(dir, "here", "state.json");
  const store = openAiradioState({ path, origin: ORIGIN });
  try {
    store.saveChannel("fm-abcdef0123456789", WAVE);
    assert.deepEqual(store.channels(), ["fm-abcdef0123456789"]);
  } finally {
    store.close();
  }
});
