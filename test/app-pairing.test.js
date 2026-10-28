import assert from "node:assert/strict";
import test from "node:test";

import { APP_SHEETS, generateOperatorPair, pairedChannels, pairingKey, pairingTrustCommands, renderApp } from "../worker/app.mjs";

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
  const id = "1".repeat(32), secret = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
  const channel = { frequency: "fm-1234abcd", key: "a".repeat(32), label: "ops" };
  const key = await pairingKey(secret, id);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key,
    new TextEncoder().encode(JSON.stringify({ expiresAt: Date.now() + 120_000, channels: [channel] }))));
  const request = JSON.stringify({ ciphertext: Buffer.concat([nonce, sealed]).toString("base64url") });
  const url = "/v1/pair/" + id;
  assert.doesNotMatch(url + request, new RegExp(channel.key, "u"), "the KEY is absent from URL and request");
  assert.doesNotMatch(url + request, new RegExp(Buffer.from(secret).toString("base64url"), "u"), "the fragment secret is absent too");
  const packed = Buffer.from(JSON.parse(request).ciphertext, "base64url");
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.subarray(0, 12) }, await pairingKey(secret, id), packed.subarray(12));
  assert.deepEqual(pairedChannels(JSON.parse(new TextDecoder().decode(opened)), []), [channel]);

  const receiver = await generateOperatorPair();
  assert.equal(receiver.privateKey.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("jwk", receiver.privateKey), /extractable/u);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64url");
  assert.equal(pairingTrustCommands([channel], publicKey, "phone-2"),
    "node radio.mjs trust fm-1234abcd " + publicKey + " --also --operator-asked --operator-name phone-2");
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
