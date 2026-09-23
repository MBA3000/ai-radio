import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { AiRadioChannel } from "../worker/worker.mjs";

const sha512 = (text) => createHash("sha512").update(text).digest("hex");

function sqliteContext({ now = Date.now } = {}) {
  const database = new DatabaseSync(":memory:");
  let alarmAt = null;
  const sql = {
    exec(statement, ...params) {
      if (params.length === 0 && statement.includes(";")) {
        database.exec(statement);
        return { toArray: () => [] };
      }
      const rows = database.prepare(statement).all(...params);
      return { toArray: () => rows };
    },
  };
  const context = {
    now,
    storage: {
      sql,
      async setAlarm(at) { alarmAt = at; },
      async deleteAll() {
        database.exec("DELETE FROM msgs; DELETE FROM meta;");
      },
    },
  };
  return { context, database, alarmAt: () => alarmAt };
}

async function initializedChannel(wave = "correct-wave", { mode, now } = {}) {
  const harness = sqliteContext({ now });
  const channel = new AiRadioChannel(harness.context);
  const initialized = await channel.fetch(new Request("https://channel/init", {
    method: "POST",
    body: JSON.stringify({ waveHash: sha512(wave), ...(mode ? { mode } : {}) }),
  }));
  assert.equal(initialized.status, 200);
  return { channel, wave, ...harness };
}

test("SQLite-backed channel rejects invalid page bounds and wrong authentication", async () => {
  const { channel, wave } = await initializedChannel();
  for (const query of ["since=-1", "since=1.5", "since=01", "since=1&since=2", "limit=0", "limit=201", "limit=2&limit=3"]) {
    const response = await channel.fetch(new Request(`https://channel/messages?${query}`, { headers: { "X-Wave": wave } }));
    assert.equal(response.status, 400, query);
  }
  const refused = await channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": "wrong" } }));
  assert.equal(refused.status, 403);
});

test("SQLite-backed channel paginates 201 ordered messages without drops", async () => {
  const { channel, wave } = await initializedChannel();
  for (let index = 1; index <= 201; index += 1) {
    const response = await channel.fetch(new Request("https://channel/send", {
      method: "POST",
      body: JSON.stringify({ wave, from: "sender", text: `message-${index}` }),
    }));
    assert.equal(response.status, 200);
  }

  const firstResponse = await channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": wave } }));
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.messages.length, 200);
  assert.deepEqual(first.messages.map((message) => message.seq), Array.from({ length: 200 }, (_, index) => index + 1));
  assert.equal(first.last, 200, "last is the last returned message, not the global maximum");
  assert.equal(first.nextSince, 200);
  assert.equal(first.hasMore, true);

  const secondResponse = await channel.fetch(new Request(`https://channel/messages?since=${first.nextSince}`, { headers: { "X-Wave": wave } }));
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.deepEqual(second.messages.map((message) => message.seq), [201]);
  assert.equal(second.last, 201);
  assert.equal(second.nextSince, 201);
  assert.equal(second.hasMore, false);
});

test("station key rotation invalidates the old key and preserves the mailbox identity", async () => {
  const oldKey = "a".repeat(128);
  const newKey = "b".repeat(128);
  const { channel } = await initializedChannel(oldKey, { mode: "mailbox" });

  const wrong = await channel.fetch(new Request("https://channel/rotate", {
    method: "POST",
    body: JSON.stringify({ oldWave: "c".repeat(128), newWaveHash: sha512(newKey) }),
  }));
  assert.equal(wrong.status, 403);

  const rotated = await channel.fetch(new Request("https://channel/rotate", {
    method: "POST",
    body: JSON.stringify({ oldWave: oldKey, newWaveHash: sha512(newKey) }),
  }));
  assert.equal(rotated.status, 200);
  assert.equal((await channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": oldKey } }))).status, 403);
  assert.equal((await channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": newKey } }))).status, 200);
});

test("call invitations expire after 900 seconds without consume-on-read and alarms retain ordinary mailbox rows", async () => {
  const base = Date.parse("2026-09-09T00:00:00.000Z");
  let now = base;
  const key = "d".repeat(128);
  const { channel } = await initializedChannel(key, { mode: "mailbox", now: () => now });
  const invitation = JSON.stringify({ type: "call", frequency: "fm-abcdef0123456789", key: "e".repeat(128), note: "short lived" });

  for (const text of [invitation, "ordinary mailbox note"]) {
    const sent = await channel.fetch(new Request("https://channel/send", {
      method: "POST",
      body: JSON.stringify({ open: true, from: "caller", text }),
    }));
    assert.equal(sent.status, 200);
  }

  now = base + 899_000;
  const read = async () => (await channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": key } }))).json();
  const first = await read();
  const second = await read();
  assert.deepEqual(second.messages, first.messages, "mailbox reads do not consume an invitation");
  assert.deepEqual(first.messages.map((row) => row.text), [invitation, "ordinary mailbox note"]);

  now = base + 901_000;
  const expired = await read();
  assert.deepEqual(expired.messages.map((row) => row.text), ["ordinary mailbox note"]);

  await channel.alarm();
  now = base + 100_000;
  const afterAlarm = await read();
  assert.deepEqual(afterAlarm.messages.map((row) => row.text), ["ordinary mailbox note"], "the alarm deletes only expired call envelopes");
});

test("a channel shows who is listening: named receives and sends, key required, on air for 90 seconds", async () => {
  const base = Date.parse("2026-09-23T12:00:00.000Z");
  let now = base;
  const { channel, wave } = await initializedChannel("listening-wave", { now: () => now });
  const receive = (name) => channel.fetch(new Request("https://channel/messages?since=0", {
    headers: { "X-Wave": wave, ...(name === undefined ? {} : { "X-Callsign": name }) },
  }));
  const listeners = async (key = wave) => {
    const response = await channel.fetch(new Request("https://channel/listeners", { headers: { "X-Wave": key } }));
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual((await listeners()).body.listeners, [], "nobody listens on a fresh channel");
  assert.equal((await receive("codex-agent")).status, 200);
  await receive(undefined);
  await receive("not a valid name!");
  assert.equal((await receive("x".repeat(65))).status, 200, "a bad name never breaks a receive");
  now = base + 5_000;
  await channel.fetch(new Request("https://channel/send", { method: "POST", body: JSON.stringify({ wave, from: "host-claude", text: "hello" }) }));

  const first = await listeners();
  assert.equal(first.status, 200);
  assert.equal(first.body.onAirWindowSeconds, 90);
  assert.deepEqual(first.body.listeners.map((row) => [row.name, row.onAir]), [["host-claude", true], ["codex-agent", true]]);

  assert.equal((await listeners("wrong")).status, 403, "the listener list is as private as the messages");

  now = base + 91_000;
  const later = await listeners();
  assert.deepEqual(later.body.listeners.map((row) => [row.name, row.onAir]), [["host-claude", true], ["codex-agent", false]]);

  for (let index = 0; index < 40; index += 1) {
    now += 1;
    await receive(`listener-${index}`);
  }
  assert.equal((await listeners()).body.listeners.length, 32, "the list keeps only the newest 32 names");
});

test("an always-on receiver does not write on every poll: idle clock and presence are throttled", async () => {
  const base = Date.parse("2026-09-23T12:00:00.000Z");
  let now = base;
  const { channel, wave, database, alarmAt } = await initializedChannel("throttle-wave", { now: () => now });
  const touched = () => database.prepare("SELECT v FROM meta WHERE k = 'lastTouched'").get().v;
  const read = (name) => channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": wave, "X-Callsign": name } }));
  const seenOf = (name) => database.prepare("SELECT lastSeen FROM listeners WHERE name = ?").get(name)?.lastSeen;

  await read("radio");
  const createdTouch = touched();
  const firstSeen = seenOf("radio");
  now = base + 9 * 60_000;
  await read("radio");
  assert.equal(touched(), createdTouch, "reads inside ten minutes leave the idle clock alone");
  assert.equal(alarmAt(), base + 7 * 24 * 60 * 60 * 1000);
  now = base + 11 * 60_000;
  await read("radio");
  assert.equal(touched(), new Date(now).toISOString(), "a read after ten minutes refreshes it");
  assert.equal(alarmAt(), now + 7 * 24 * 60 * 60 * 1000, "and pushes the idle purge back");

  now += 5_000;
  const before = seenOf("radio");
  await read("radio");
  assert.equal(seenOf("radio"), before, "presence is stamped at most every 15 seconds");
  assert.notEqual(before, firstSeen);
  now += 15_000;
  await read("radio");
  assert.equal(seenOf("radio"), new Date(now).toISOString());

  const sent = await channel.fetch(new Request("https://channel/send", { method: "POST", body: JSON.stringify({ wave, from: "radio", text: "x" }) }));
  assert.equal(sent.status, 200);
  assert.equal(touched(), new Date(now).toISOString(), "a write always refreshes the idle clock");
});

test("mailbox presence is throttled too, and a mailbox has no channel listeners", async () => {
  const base = Date.parse("2026-09-23T12:00:00.000Z");
  let now = base;
  const key = "f".repeat(128);
  const { channel, database } = await initializedChannel(key, { mode: "mailbox", now: () => now });
  const lastSeen = () => database.prepare("SELECT v FROM meta WHERE k = 'lastSeen'").get()?.v;
  const read = () => channel.fetch(new Request("https://channel/messages?since=0", { headers: { "X-Wave": key, "X-Callsign": "someone" } }));

  await read();
  assert.equal(lastSeen(), new Date(base).toISOString());
  now = base + 10_000;
  await read();
  assert.equal(lastSeen(), new Date(base).toISOString());
  now = base + 16_000;
  await read();
  assert.equal(lastSeen(), new Date(now).toISOString());
  const presence = await (await channel.fetch(new Request("https://channel/presence"))).json();
  assert.equal(presence.onAir, true);

  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM listeners").get().n, 0, "mailbox readers are not channel listeners");
  const refused = await channel.fetch(new Request("https://channel/listeners", { headers: { "X-Wave": key } }));
  assert.equal(refused.status, 404);
});
