import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { APP_SHEETS, applyReceivedPairing, generateOperatorPair, pairedChannels, pairingKey, pairingSendHandlers, pairingTrustCommands, receivePairing, renderApp } from "../worker/app.mjs";

test("pairing sheets open and close with every other modal", () => {
  const elements = new Map(APP_SHEETS.map((id) => [id, { hidden: true }]));
  function sheet(id) { APP_SHEETS.forEach((name) => { elements.get(name).hidden = name !== id; }); }
  for (const id of ["sheet-pair", "sheet-paired"]) {
    sheet(id);
    assert.equal(elements.get(id).hidden, false, id + " opens");
    assert.equal([...elements.values()].filter((item) => !item.hidden).length, 1, "only that sheet is visible");
    sheet(null);
    assert.equal([...elements.values()].every((item) => item.hidden), true, id + " closes");
  }
});

test("a decrypted package cannot inject a trust command", () => {
  const future = Date.now() + 60_000;
  const channels = pairedChannels({ expiresAt: future, channels: [
    { frequency: "fm-1234abcd", key: "a".repeat(32), label: "safe" },
    { frequency: "fm-deadbeef;printf injected;#", key: "b".repeat(32), label: "hostile" },
    { frequency: "prefix-fm-cafebabe", key: "c".repeat(32) },
  ] }, []);
  assert.equal(channels, null, "one hostile record rejects the complete package");
  const safe = pairedChannels({ expiresAt: future, channels: [{ frequency: "fm-1234abcd", key: "a".repeat(32), label: "safe" }] }, []);
  const commands = pairingTrustCommands(safe, "B".repeat(86), "phone-2");
  assert.equal(commands, "node radio.mjs trust fm-1234abcd " + "B".repeat(86) + " --also --operator-asked --operator-name phone-2");
  assert.doesNotMatch(commands, /printf|;/u);
});

test("the complete client transfer hides secrets and gives the receiver its own key", async () => {
  const channel = { frequency: "fm-1234abcd", key: "a".repeat(32), label: "ops" };
  const requests = [], logs = [], shown = [];
  let link = "", qrFailed = false, randomCall = 0;
  const handlers = pairingSendHandlers({
    channels: () => [channel], short: (value) => value, toast: (value) => logs.push(value),
    showChannels: (value) => shown.push(value), reset() {}, showSheet() {}, disable() {},
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall), pairingKey,
    b64url: (value) => Buffer.from(value).toString("base64url"),
    post: async (url, body) => { requests.push({ url, body }); return { status: 201 }; },
    origin: () => "https://airadio.example", showLink: (value) => { link = value; },
    drawQr() { throw new Error("canvas unavailable"); }, qrFailed: () => { qrFailed = true; },
    failed: (value) => logs.push(value),
  });
  handlers.open();
  assert.deepEqual(shown, ["ops"], "opening shows the channels handled by the real UI handler");
  assert.equal(requests.length, 0, "opening the confirmation sheet does not transfer anything");
  await handlers.confirm();
  assert.equal(requests.length, 1, "only Confirm starts the POST");
  const { url, body: request } = requests[0];
  const secret = new Uint8Array(32).fill(2);
  assert.equal(url, "/v1/pair/" + "01".repeat(16));
  assert.doesNotMatch(url + request + logs.join("\n"), new RegExp(channel.key, "u"), "the KEY is absent from URL, request, and logs");
  assert.doesNotMatch(url + request + logs.join("\n"), new RegExp(Buffer.from(secret).toString("base64url"), "u"), "the pairing secret is absent too");
  assert.match(link, new RegExp("#pair=" + "01".repeat(16), "u"));
  assert.equal(qrFailed, true, "the link remains available when QR drawing fails");
  const packed = Buffer.from(JSON.parse(request).ciphertext, "base64url");
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.subarray(0, 12) }, await pairingKey(secret, "01".repeat(16)), packed.subarray(12));
  assert.deepEqual(pairedChannels(JSON.parse(new TextDecoder().decode(opened)), []), [channel]);

  const receiver = await generateOperatorPair();
  assert.equal(receiver.privateKey.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("jwk", receiver.privateKey), /extractable/u);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64url");
  assert.equal(pairingTrustCommands([channel], publicKey, "phone-2"),
    "node radio.mjs trust fm-1234abcd " + publicKey + " --also --operator-asked --operator-name phone-2");
});

test("an existing channel still gets a trust command but is not duplicated", () => {
  const channel = { frequency: "fm-1234abcd", key: "a".repeat(32), label: "ops" };
  const verified = pairedChannels({ expiresAt: Date.now() + 60_000, channels: [channel] }, [channel.frequency]);
  assert.deepEqual(verified, [channel], "validation retains already stored channels for trust commands");
  const newChannels = verified.filter((item) => !new Set([channel.frequency]).has(item.frequency));
  assert.deepEqual(newChannels, [], "storage filtering remains separate");
  assert.match(pairingTrustCommands(verified, "B".repeat(86), "phone-2"), /trust fm-1234abcd/u);
});

test("the real receiver imports channels and shows its own key and trust commands", async () => {
  const id = "12".repeat(16), secret = new Uint8Array(32).fill(7), nonce = new Uint8Array(12).fill(8);
  const channel = { frequency: "fm-1234abcd", key: "a".repeat(32), label: "ops" };
  const plain = new TextEncoder().encode(JSON.stringify({ expiresAt: Date.now() + 60_000, channels: [channel] }));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await pairingKey(secret, id), plain);
  const packed = new Uint8Array(12 + sealed.byteLength); packed.set(nonce); packed.set(new Uint8Array(sealed), 12);
  let cleared = 0, accepted;
  const done = new Promise((resolve, reject) => {
    assert.equal(receivePairing({
      hash: () => "#pair=" + id + "." + Buffer.from(secret).toString("base64url"),
      unb64url: (text) => new Uint8Array(Buffer.from(text, "base64url")), clearHash: () => { cleared += 1; },
      operatorReady: async () => ({ key: "ready" }),
      get: async (url) => ({ status: 200, body: { ciphertext: Buffer.from(packed).toString("base64url") }, url }),
      pairingKey, pairedChannels, accept: (channels) => { accepted = channels; resolve(); }, failed: reject,
    }), true);
  });
  await done;
  assert.equal(cleared, 1);
  assert.deepEqual(accepted, [channel], "the production receiver validates and delivers the decrypted channels");
  const receiver = await generateOperatorPair();
  const key = Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64url");
  const stored = [], shown = [];
  const result = await applyReceivedPairing(accepted, {
    channels: () => stored, add: (value) => stored.push(value), save() {}, render() {},
    operatorReady: async () => ({ key }), commands: pairingTrustCommands, name: () => "phone-2",
    show: (shownKey, commands) => shown.push({ key: shownKey, commands }),
  });
  const command = "node radio.mjs trust fm-1234abcd " + key + " --also --operator-asked --operator-name phone-2";
  assert.equal(stored[0].key, channel.key, "the actual receiver storage path imports the channel");
  assert.deepEqual(shown, [{ key, commands: command }], "the actual UI path reveals the key and exact command");
  assert.deepEqual(result, { key, commands: command });
});

test("a receiver without operator key storage does not consume the one-time package", async () => {
  let gets = 0, accepts = 0;
  const failure = new Promise((resolve) => {
    assert.equal(receivePairing({
      hash: () => "#pair=" + "12".repeat(16) + "." + "A".repeat(43),
      unb64url: () => new Uint8Array(32), clearHash() {}, operatorReady: async () => null,
      get: async () => { gets += 1; return { status: 500 }; }, accept: async () => { accepts += 1; },
      failed: resolve,
    }), true);
  });
  assert.match(await failure, /operator key/i);
  assert.equal(gets, 0, "the relay package remains unconsumed");
  assert.equal(accepts, 0, "no channels are imported");
});

test("operator key creation failure is reported without consuming or importing", async () => {
  const creationError = new Error("IndexedDB write failed");
  let gets = 0, accepts = 0;
  const failure = new Promise((resolve) => {
    receivePairing({
      hash: () => "#pair=" + "34".repeat(16) + "." + "B".repeat(43),
      unb64url: () => new Uint8Array(32), clearHash() {}, operatorReady: async () => { throw creationError; },
      get: async () => { gets += 1; return { status: 500 }; }, accept: async () => { accepts += 1; },
      failed: resolve,
    });
  });
  assert.equal(await failure, creationError.message);
  assert.equal(gets, 0, "the one-shot GET waits for successful key creation");
  assert.equal(accepts, 0);
});

test("a rejected channel import is reported by the pairing receiver", async () => {
  const id = "56".repeat(16), secret = new Uint8Array(32).fill(9), nonce = new Uint8Array(12).fill(4);
  const shared = { expiresAt: Date.now() + 60_000, channels: [{ frequency: "fm-1234abcd", key: "a".repeat(32) }] };
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await pairingKey(secret, id), new TextEncoder().encode(JSON.stringify(shared)));
  const packed = new Uint8Array(12 + sealed.byteLength); packed.set(nonce); packed.set(new Uint8Array(sealed), 12);
  const importError = new Error("storage unavailable");
  const failure = new Promise((resolve) => receivePairing({
    hash: () => "#pair=" + id + "." + Buffer.from(secret).toString("base64url"),
    unb64url: (text) => new Uint8Array(Buffer.from(text, "base64url")), clearHash() {}, operatorReady: async () => ({ key: "ready" }),
    get: async () => ({ status: 200, body: { ciphertext: Buffer.from(packed).toString("base64url") } }),
    pairingKey, pairedChannels, accept: async () => { throw importError; }, failed: resolve,
  }));
  assert.equal(await failure, importError.message);
});

test("routing can receive a newly changed pairing hash once, while malformed secrets do not stop startup", () => {
  const html = renderApp({ nonce: "0".repeat(32) });
  assert.match(html, /function route\(\) \{[\s\S]*receivePairing\(pairingReceiver\)/u,
    "hashchange's route invokes the receiver");
  let gets = 0, cleared = 0;
  const deps = { hash: () => "#pair=" + "1".repeat(32) + ".A", unb64url() { throw new DOMException("bad", "InvalidCharacterError"); },
    clearHash() { cleared += 1; }, get() { gets += 1; }, failed() {} };
  assert.doesNotThrow(() => receivePairing(deps));
  assert.equal(receivePairing(deps), false);
  assert.equal(gets, 0); assert.equal(cleared, 0);
});

test("the QR's two format copies are independently readable as level L, mask 0", () => {
  const html = renderApp({ nonce: "0".repeat(32) });
  const source = /function drawQr\(canvas, text\) \{[\s\S]*?\n  \}\n  function fingerprintOf/u.exec(html)[0].replace(/\n  function fingerprintOf$/u, "");
  const drawQr = Function("TextEncoder", "return (" + source + ")")(TextEncoder);
  const dark = new Set();
  const canvas = { getContext: () => ({ fillStyle: "", fillRect(x, y, w, h) { if (this.fillStyle === "black" && w === 1 && h === 1) dark.add((y - 4) + "," + (x - 4)); } }) };
  drawQr(canvas, "https://airadio.example/app#pair=" + "1".repeat(32) + "." + "A".repeat(43));
  const size = 41;
  const copies = [
    [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]],
    [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]],
  ];
  for (const positions of copies) {
    const format = positions.reduce((value, [row, col], i) => value | (dark.has(row + "," + col) ? 1 << (14 - i) : 0), 0);
    assert.equal(format, 0x77c4, "the format codeword is an exact, independently read BCH codeword");
  }
});

test("a long workers.dev pairing URL uses a larger QR", () => {
  const html = renderApp({ nonce: "0".repeat(32) });
  const source = /function drawQr\(canvas, text\) \{[\s\S]*?\n  \}\n  function fingerprintOf/u.exec(html)[0].replace(/\n  function fingerprintOf$/u, "");
  const drawQr = Function("TextEncoder", "return (" + source + ")")(TextEncoder);
  const canvas = { getContext: () => ({ fillStyle: "", fillRect() {} }) };
  const url = "https://" + "staging-".repeat(6) + "account.workers.dev/app#pair=" + "1".repeat(32) + "." + "A".repeat(43);
  assert.ok(new TextEncoder().encode(url).length > 134);
  drawQr(canvas, url);
  assert.equal(canvas.width, 57, "version 8-L is selected for the longer hostname");
});

test("both complete QR matrices match independent Model 2 reference fixtures", () => {
  const html = renderApp({ nonce: "0".repeat(32) });
  const source = /function drawQr\(canvas, text\) \{[\s\S]*?\n  \}\n  function fingerprintOf/u.exec(html)[0].replace(/\n  function fingerprintOf$/u, "");
  const drawQr = Function("TextEncoder", "return (" + source + ")")(TextEncoder);
  const cases = [
    ["https://airadio.example/app#pair=" + "1".repeat(32) + "." + "A".repeat(43), 49, "92d94aa100ae55d7d52661c6266133b3f26234b50a53948faaba756355348aec"],
    ["https://" + "staging-".repeat(6) + "account.workers.dev/app#pair=" + "1".repeat(32) + "." + "A".repeat(43), 57, "dca04a07159d737379a338d4e515e1a358dc30d24fcb717086b7f9f041f54912"],
  ];
  for (const [url, expectedSize, referenceDigest] of cases) {
    const dark = new Set();
    const canvas = { getContext: () => ({ fillStyle: "", fillRect(x, y, width, height) {
      if (this.fillStyle === "black" && width === 1 && height === 1) dark.add(x + "," + y);
    } }) };
    drawQr(canvas, url);
    let matrix = "";
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) matrix += dark.has(x + "," + y) ? "1" : "0";
    assert.equal(canvas.width, expectedSize);
    assert.equal(createHash("sha256").update(matrix).digest("hex"), referenceDigest,
      "every module, including payload and error correction, matches the independent reference");
  }
});
