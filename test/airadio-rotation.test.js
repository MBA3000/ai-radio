import assert from "node:assert/strict";
import test from "node:test";

import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";
import { AiRadioChannel } from "../worker/worker.mjs";

test("concurrent old-key rotations have exactly one committed winner", { timeout: 10_000 }, async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const registered = await (await fetch(`${station.url}/v1/station`, jsonPost({ callsign: "atomic-rotation" }))).json();
  const original = AiRadioChannel.prototype.verified;
  let admitted = 0;
  let release;
  const bothAuthorized = new Promise((resolve) => { release = resolve; });
  t.mock.method(AiRadioChannel.prototype, "verified", async function (wave) {
    const result = await original.call(this, wave);
    if (wave === registered.key && result === null && admitted < 2) {
      admitted += 1;
      if (admitted === 2) release();
      await bothAuthorized;
    }
    return result;
  });
  const rotate = () => fetch(`${station.url}/v1/station/atomic-rotation/rotate`, {
    ...jsonPost(), headers: { ...jsonPost().headers, "X-Wave": registered.key },
  });
  const responses = await Promise.all([rotate(), rotate()]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(admitted, 2, "both real validations must finish before either update");
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
  const winner = bodies[responses.findIndex((response) => response.status === 200)];
  const loser = bodies[responses.findIndex((response) => response.status === 403)];
  assert.match(winner.key, /^[a-f0-9]{128}$/u);
  assert.equal(loser.key, undefined);
  const old = await fetch(`${station.url}/v1/station/atomic-rotation/calls?since=0`, { headers: { "X-Wave": registered.key } });
  assert.equal(old.status, 403); await old.text();
  const current = await fetch(`${station.url}/v1/station/atomic-rotation/calls?since=0`, { headers: { "X-Wave": winner.key } });
  assert.equal(current.status, 200); await current.text();
});

const jsonPost = (body = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.44" },
  body: JSON.stringify(body),
});

test("the real Worker and SQLite storage rotate a station key without replacing its mailbox", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());

  const registeredResponse = await fetch(`${station.url}/v1/station`, jsonPost({ callsign: "rotate-test" }));
  assert.equal(registeredResponse.status, 200);
  const registered = await registeredResponse.json();

  const rotatedResponse = await fetch(`${station.url}/v1/station/rotate-test/rotate`, {
    ...jsonPost(),
    headers: { ...jsonPost().headers, "X-Wave": registered.key },
  });
  assert.equal(rotatedResponse.status, 200);
  assert.equal(rotatedResponse.headers.get("cache-control"), "no-store");
  const rotated = await rotatedResponse.json();
  assert.equal(rotated.callsign, "rotate-test");
  assert.match(rotated.key, /^[a-f0-9]{128}$/u);
  assert.notEqual(rotated.key, registered.key);

  const oldRead = await fetch(`${station.url}/v1/station/rotate-test/calls?since=0`, { headers: { "X-Wave": registered.key } });
  assert.equal(oldRead.status, 403);
  const newRead = await fetch(`${station.url}/v1/station/rotate-test/calls?since=0`, { headers: { "X-Wave": rotated.key } });
  assert.equal(newRead.status, 200);

  const wrongRotate = await fetch(`${station.url}/v1/station/rotate-test/rotate`, {
    ...jsonPost(),
    headers: { ...jsonPost().headers, "X-Wave": registered.key },
  });
  assert.equal(wrongRotate.status, 403);
});
