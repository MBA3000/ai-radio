import assert from "node:assert/strict";
import test from "node:test";

import { APP_SHEETS, generateOperatorPair, pairedChannels, pairingKey, pairingSendHandlers, pairingTrustCommands, renderApp } from "../worker/app.mjs";

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
