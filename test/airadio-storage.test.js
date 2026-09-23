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
