/**
 * The installable app and its notifications.
 *
 * Web Push is two standards the station implements with WebCrypto alone:
 * RFC 8291 encryption (only the phone can read a message) and RFC 8292 VAPID
 * (the station identifies itself to Apple's, Google's or Mozilla's push
 * service). Both are checked here against independent evidence: the RFC's own
 * worked example, a decryption written with node:crypto, and a signature
 * verified with the public key the station hands to browsers.
 */

import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { b64url, encryptPushPayload, fromB64url, generateVapidKeys, parseSubscription, pushEndpointAllowed, vapidAuthorization } from "../worker/push.mjs";
import { iconPixels } from "../worker/icon.mjs";
import { startAiradioLocalStation } from "./helpers/airadio-local-station.js";

/** A browser's push subscription, made with node:crypto: the private half stays here. */
function fakeDevice(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } },
    decrypt(body) {
      const bytes = Buffer.from(body);
      const salt = bytes.subarray(0, 16);
      const idlen = bytes[20];
      const serverKey = bytes.subarray(21, 21 + idlen);
      const ciphertext = bytes.subarray(21 + idlen);
      const secret = ecdh.computeSecret(serverKey);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverKey]), 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
      let end = padded.length - 1;
      while (end >= 0 && padded[end] === 0) end -= 1;
      assert.equal(padded[end], 2, "a single record ends with the 0x02 delimiter");
      return padded.subarray(0, end).toString("utf8");
    },
  };
}

test("encryption reproduces RFC 8291's own example byte for byte", async () => {
  const pub = fromB64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) };
  const serverKeys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
  const body = await encryptPushPayload(
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    { salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), serverKeys },
  );
  assert.equal(b64url(body), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("a message encrypted by the station decrypts on the device with node:crypto", async () => {
  const device = fakeDevice("https://fcm.googleapis.com/fcm/send/abc");
  const text = JSON.stringify({ from: "codex-agent", text: "Build is green. Should I deploy staging? ✅" });
  const body = await encryptPushPayload(device.subscription.keys, new TextEncoder().encode(text));
  assert.equal(device.decrypt(body), text);
  const again = await encryptPushPayload(device.subscription.keys, new TextEncoder().encode(text));
  assert.notEqual(b64url(again), b64url(body), "a fresh salt and server key per message");
  await assert.rejects(() => encryptPushPayload(device.subscription.keys, new Uint8Array(4000)), /too large/u);
});

test("VAPID: an ES256 JWT for the push service's origin, verifiable with the key browsers are given", async () => {
  const vapid = await generateVapidKeys();
  assert.equal(fromB64url(vapid.publicKey).length, 65);
  const now = Date.parse("2026-09-24T12:00:00Z");
  const header = await vapidAuthorization({ endpoint: "https://web.push.apple.com/QGuQyavXutnMbahg", vapid, subject: "https://airadio.example", now });
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(header);
  assert.ok(match, header);
  const [, head, claims, signature, key] = match;
  assert.equal(key, vapid.publicKey);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(head))), { typ: "JWT", alg: "ES256" });
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(claims)));
  assert.equal(payload.aud, "https://web.push.apple.com");
  assert.equal(payload.sub, "https://airadio.example");
  assert.equal(payload.exp, now / 1000 + 12 * 3600, "twelve hours: inside every push service's 24-hour limit");
  const publicKey = await crypto.subtle.importKey("raw", fromB64url(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromB64url(signature), new TextEncoder().encode(head + "." + claims)), true);
});

test("the station posts only to real push services", () => {
  for (const endpoint of [
    "https://web.push.apple.com/QGuQyavXutnMbahg",
    "https://api.push.apple.com/x",
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ]) assert.equal(pushEndpointAllowed(endpoint), true, endpoint);
  for (const endpoint of [
    "http://web.push.apple.com/x",
    "https://evil.example/web.push.apple.com",
    "https://web.push.apple.com.evil.example/x",
    "https://web.push.apple.com:8443/x",
    "https://user@fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "not a url",
    "https://fcm.googleapis.com/" + "a".repeat(1100),
  ]) assert.equal(pushEndpointAllowed(endpoint), false, endpoint);
  const device = fakeDevice("https://fcm.googleapis.com/fcm/send/abc");
  assert.deepEqual(parseSubscription(device.subscription), device.subscription);
  assert.match(parseSubscription({ endpoint: "https://evil.example/x", keys: device.subscription.keys }).error, /known push service/u);
  assert.match(parseSubscription({ endpoint: device.subscription.endpoint, keys: { p256dh: "AAAA", auth: device.subscription.keys.auth } }).error, /P-256/u);
  assert.match(parseSubscription({ endpoint: device.subscription.endpoint }).error, /required/u);
});

async function stationWithPushCapture(t, respond = () => 201) {
  const pushes = [];
  const station = await startAiradioLocalStation({
    bindings: {
      AIRADIO_PUSH_FETCH: async (url, init) => {
        pushes.push({ url: String(url), headers: init.headers, body: new Uint8Array(init.body) });
        return new Response(null, { status: respond(String(url)) });
      },
    },
  });
  t.after(() => station.close());
  const created = await (await fetch(station.url + "/v1/channel", { method: "POST" })).json();
  const channel = {
    frequency: created.frequency,
    wave: created.wave,
    say: (from, text) => fetch(station.url + "/v1/channel/" + created.frequency + "/send", {
      method: "POST",
      headers: { "X-Wave": created.wave, "content-type": "application/json" },
      body: JSON.stringify({ from, text }),
    }),
    subscribe: (device, name, wave = created.wave, action = "subscribe") => fetch(station.url + "/v1/channel/" + created.frequency + "/" + action, {
      method: "POST",
      headers: { "X-Wave": wave, "content-type": "application/json" },
      body: JSON.stringify({ ...device.subscription, name }),
    }),
  };
  return { station, channel, pushes };
}

test("a message on a channel reaches each subscribed phone, encrypted, and never the sender's own", async (t) => {
  const { station, channel, pushes } = await stationWithPushCapture(t);
  const key = await (await fetch(station.url + "/v1/push/key")).json();
  assert.equal(fromB64url(key.publicKey).length, 65, "browsers get the station's VAPID public key");
  assert.equal((await (await fetch(station.url + "/v1/push/key")).json()).publicKey, key.publicKey, "the key pair is made once and kept");

  const phone = fakeDevice("https://web.push.apple.com/phone-1");
  assert.equal((await channel.subscribe(phone, "medet")).status, 200);
  assert.equal((await channel.subscribe(phone, "medet", "f".repeat(128))).status, 403, "only key holders subscribe");
  assert.equal((await channel.subscribe(fakeDevice("https://evil.example/x"), "x")).status, 400, "only push services");

  const sent = await channel.say("codex-agent", "Build is green. Deploy staging?");
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(await sent.json()), ["seq"], "the send answer never shows who gets notified");
  assert.equal(pushes.length, 1);
  const [push] = pushes;
  assert.equal(push.url, "https://web.push.apple.com/phone-1");
  assert.equal(push.headers["Content-Encoding"], "aes128gcm");
  assert.equal(push.headers.TTL, "86400");
  assert.equal(push.headers.Topic, channel.frequency.slice(0, 32));
  assert.match(push.headers.Authorization, new RegExp("^vapid t=[^ ]+, k=" + key.publicKey + "$", "u"));
  const payload = JSON.parse(phone.decrypt(push.body));
  assert.equal(payload.frequency, channel.frequency);
  assert.equal(payload.from, "codex-agent");
  assert.equal(payload.text, "Build is green. Deploy staging?");
  assert.equal(payload.seq, 1);

  await channel.say("medet", "yes, go");
  assert.equal(pushes.length, 1, "your own words never ring your own phone");
  await channel.say("codex-agent", "deploying");
  assert.equal(pushes.length, 1, "at most one notification per phone every 10 s");

  assert.equal((await channel.subscribe(phone, "medet", channel.wave, "unsubscribe")).status, 200);
});

test("a phone the push service forgot is dropped, and a channel keeps at most 16", async (t) => {
  const gone = "https://fcm.googleapis.com/fcm/send/gone";
  const { channel, pushes } = await stationWithPushCapture(t, (url) => (url === gone ? 410 : 201));
  for (let index = 0; index < 18; index += 1) {
    const endpoint = index === 17 ? gone : "https://fcm.googleapis.com/fcm/send/device-" + index;
    assert.equal((await channel.subscribe(fakeDevice(endpoint), "phone-" + index)).status, 200);
  }
  await channel.say("agent", "hello");
  assert.equal(pushes.length, 16, "the newest 16 subscriptions are kept");
  assert.ok(pushes.some((push) => push.url === gone));
  await new Promise((ok) => setTimeout(ok, 10_100));
  pushes.length = 0;
  await channel.say("agent", "again");
  assert.equal(pushes.length, 15, "the 410 subscription is gone");
  assert.ok(!pushes.some((push) => push.url === gone));
});

test("the app installs: manifest, service worker, icons and /app", async (t) => {
  const station = await startAiradioLocalStation();
  t.after(() => station.close());
  const manifestResponse = await fetch(station.url + "/manifest.webmanifest");
  assert.match(manifestResponse.headers.get("content-type"), /^application\/manifest\+json/u);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "AI RADIO");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/app?source=home-screen");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of [...manifest.icons, { src: "/apple-touch-icon.png", sizes: "180x180" }]) {
    const response = await fetch(station.url + icon.src);
    assert.equal(response.status, 200, icon.src);
    assert.equal(response.headers.get("content-type"), "image/png");
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
    const size = Number(icon.sizes.split("x")[0]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    const idat = png.indexOf("IDAT");
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    assert.equal(raw.length, size * (1 + size * 3), "every row decodes");
  }

  const worker = await fetch(station.url + "/sw.js");
  assert.match(worker.headers.get("content-type"), /^text\/javascript/u);
  const workerSource = await worker.text();
  assert.match(workerSource, /showNotification/u);
  assert.match(workerSource, /notificationclick/u);
  assert.doesNotMatch(workerSource, /addEventListener\("fetch"/u, "the service worker intercepts nothing");

  const app = await fetch(station.url + "/app");
  const csp = app.headers.get("content-security-policy");
  const nonce = /script-src 'nonce-([a-f0-9]{32})'/u.exec(csp)[1];
  assert.match(csp, /worker-src 'self'/u);
  assert.match(csp, /manifest-src 'self'/u);
  const html = await app.text();
  for (const must of ['<link rel="manifest" href="/manifest.webmanifest">', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', 'name="apple-mobile-web-app-capable" content="yes"', "viewport-fit=cover", '<script nonce="' + nonce + '">', "Add to Home Screen"]) {
    assert.ok(html.includes(must), must);
  }
  assert.ok(!/<script(?![^>]*nonce=)/u.test(html));
  new Function(html.slice(html.indexOf('<script nonce="' + nonce + '">') + 49, html.lastIndexOf("</script>")));

  const landing = await (await fetch(station.url + "/", { headers: { accept: "text/html" } })).text();
  for (const must of ['<link rel="manifest" href="/manifest.webmanifest">', 'href="/app"', "Share → Add to Home Screen", "A pager for long jobs", "Reachable behind NAT"]) {
    assert.ok(landing.includes(must), must);
  }
});

test("the icon is the station's mark: amber on the dark field, centred", () => {
  const size = 64;
  const pixels = iconPixels(size);
  const at = (x, y) => [...pixels.subarray((y * size + x) * 3, (y * size + x) * 3 + 3)];
  assert.deepEqual(at(0, 0), [0x12, 0x15, 0x13], "the corner is the dark field");
  const dot = at(32, Math.round(64 * ((19 + 16 - 13.35) / 32)) - 1);
  assert.ok(dot[0] > 240 && dot[1] > 160 && dot[2] < 110, "the dot is amber: " + dot);
});
