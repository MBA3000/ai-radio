#!/usr/bin/env node
// End-to-end Web Push through a REAL push service, for a deployed station.
//
//   npm run airadio:push-probe -- https://airadio-staging.example.workers.dev
//
// Registers with Mozilla's production push service (autopush, over the
// WebSocket protocol Firefox speaks), subscribes that endpoint to a fresh
// channel on the station, speaks on the channel, and decrypts what arrives.
// A pass proves the station's VAPID signature and RFC 8291 encryption are
// accepted by real push infrastructure. Network-dependent: not part of npm test.

import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";

const station = (process.argv[2] || "").replace(/\/+$/u, "");
if (!/^https:\/\//u.test(station)) {
  console.error("usage: node scripts/airadio-push-probe.mjs <https station origin>");
  process.exit(2);
}

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const auth = randomBytes(16);

function decrypt(body) {
  const salt = body.subarray(0, 16);
  const serverKey = body.subarray(21, 21 + body[20]);
  const ciphertext = body.subarray(21 + body[20]);
  const secret = ecdh.computeSecret(serverKey);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverKey]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  return padded.subarray(0, end).toString("utf8");
}

const received = [];
const socket = new WebSocket("wss://push.services.mozilla.com/");
socket.addEventListener("message", (event) => received.push(JSON.parse(event.data)));
async function next(type, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const index = received.findIndex((message) => message.messageType === type);
    if (index >= 0) return received.splice(index, 1)[0];
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error("no " + type + " from the push service within " + ms / 1000 + " s");
}

let failed = false;
const check = (ok, text) => {
  console.log((ok ? "PASS " : "FAIL ") + text);
  if (!ok) failed = true;
};

try {
  const { publicKey } = await (await fetch(station + "/v1/push/key")).json();
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok);
    socket.addEventListener("error", () => fail(new Error("cannot reach wss://push.services.mozilla.com/")));
  });
  socket.send(JSON.stringify({ messageType: "hello", use_webpush: true, uaid: "", broadcasts: {} }));
  await next("hello", 15_000);
  socket.send(JSON.stringify({ messageType: "register", channelID: randomUUID(), key: publicKey }));
  const { pushEndpoint } = await next("register", 15_000);

  const channel = await (await fetch(station + "/v1/channel", { method: "POST" })).json();
  const headers = { "X-Wave": channel.wave, "content-type": "application/json" };
  const say = (from, text) => fetch(station + "/v1/channel/" + channel.frequency + "/send", { method: "POST", headers, body: JSON.stringify({ from, text }) });
  const subscribed = await fetch(station + "/v1/channel/" + channel.frequency + "/subscribe", {
    method: "POST",
    headers,
    body: JSON.stringify({ endpoint: pushEndpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, name: "push-probe" }),
  });
  check(subscribed.status === 200, "the station accepted a real push subscription");

  const text = "push probe at " + new Date().toISOString() + " ✨";
  await say("probe-agent", text);
  const note = await next("notification", 30_000);
  socket.send(JSON.stringify({ messageType: "ack", updates: [{ channelID: note.channelID, version: note.version, code: 100 }] }));
  const payload = JSON.parse(decrypt(Buffer.from(note.data, "base64url")));
  check(payload.text === text && payload.from === "probe-agent" && payload.frequency === channel.frequency, "the push service accepted the VAPID signature and the message decrypted exactly");

  await say("push-probe", "my own words");
  await new Promise((ok) => setTimeout(ok, 6_000));
  check(!received.some((message) => message.messageType === "notification"), "the sender's own message did not notify");
} catch (error) {
  check(false, error.message);
} finally {
  socket.close();
}
process.exitCode = failed ? 1 : 0;
