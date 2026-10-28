// Real receiver and signing paths; only station traffic is mocked.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanReply, leaksSecret, radioPaths, runReceiver, verifyAgentSigned } from "../scripts/airadio-radio.mjs";

const frequency = "fm-0123456789abcdef";
const spaced = (value) => value.match(/.{1,11}/gu).join(" \n\t");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
async function eventually(check) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), "receiver completed the operation");
}

function identity() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    scalar: Buffer.from(jwk.d, "base64url"),
  };
}

async function receiver(t, { channel = {}, own = identity(), reply } = {}) {
  const root = mkdtempSync(join(tmpdir(), "airadio-agent-security-"));
  const home = join(root, "home");
  mkdirSync(home);
  const paths = radioPaths(home);
  writeFileSync(paths.agentKey, JSON.stringify({ publicKey: own.publicKey, privateKey: own.privateKey }), { mode: 0o600 });
  const config = { channels: { [frequency]: {
    station: "https://station.test", key: randomBytes(32).toString("hex"), as: "bot", ...channel,
    agent: { epoch: 1, maxPerHour: 1, exec: "cat reply.txt", cwd: root },
  } } };
  writeFileSync(paths.config, JSON.stringify(config));
  if (reply === undefined) {
    // Keep the real queue without launching an agent for mandate tests.
    writeFileSync(paths.state, JSON.stringify({ agents: { [frequency]: { epoch: 1, wakes: [Date.now()], pending: [], pausedNotice: true } } }));
  } else writeFileSync(join(root, "reply.txt"), reply);
  let socket;
  const rows = [];
  const posts = [];
  t.mock.method(globalThis, "WebSocket", function () {
    socket = { close() {}, send() {} };
    queueMicrotask(() => socket.onmessage({ data: '{"type":"hello","lastSeq":0}' }));
    return socket;
  });
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/send")) {
      posts.push(JSON.parse(options.body));
      return Response.json({ seq: 100 });
    }
    assert.equal(target.pathname, "/v1/channel/" + frequency + "/messages");
    return Response.json({ messages: rows.filter((row) => row.seq > Number(target.searchParams.get("since"))), hasMore: false });
  });
  const running = runReceiver({ home, log: () => {} });
  t.after(async () => {
    writeFileSync(paths.config, '{"channels":{}}');
    writeFileSync(paths.poke, "stop test receiver");
    await running;
    rmSync(root, { recursive: true, force: true });
  });
  await eventually(() => { try { return json(paths.state).delivery?.[frequency] === "socket"; } catch { return false; } });
  const entries = () => {
    try { return readFileSync(paths.inbox, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
  };
  const deliver = async (message, transport = "WS") => {
    if (transport === "REST") {
      rows.push(message);
      socket.onmessage({ data: JSON.stringify({ type: "message", msg: { seq: message.seq } }) });
    } else socket.onmessage({ data: JSON.stringify({ type: "message", msg: message }) });
    await eventually(() => entries().some((entry) => entry.seq === message.seq));
  };
  return { paths, posts, entries, deliver };
}

test("base64 PEM split by whitespace is detected after reply cleaning", () => {
  const pem = identity().privateKey;
  const encoded = Buffer.from(pem).toString("base64");
  const reply = "encoded key: " + spaced(encoded);
  assert.equal(leaksSecret(reply, [pem, encoded]), true);
  assert.equal(leaksSecret(cleanReply(reply, [pem, encoded]), [pem, encoded]), true);
});

test("spaced channel keys still withhold the whole reply", () => {
  const key = randomBytes(64).toString("hex");
  assert.equal(leaksSecret(cleanReply("answer: " + spaced(key), [key]), [key]), true);
});

const encodings = {
  "scalar hex": (own) => own.scalar.toString("hex"),
  "scalar uppercase spaced hex": (own) => spaced(own.scalar.toString("hex").toUpperCase()),
  "scalar base64": (own) => own.scalar.toString("base64"),
  "scalar spaced base64url": (own) => spaced(own.scalar.toString("base64url")),
  "spaced base64 PEM": (own) => spaced(Buffer.from(own.privateKey).toString("base64")),
  "spaced base64url PEM": (own) => spaced(Buffer.from(own.privateKey).toString("base64url")),
};
for (const [name, encode] of Object.entries(encodings)) {
  test("receiver never posts a reply containing " + name, async (t) => {
    const own = identity();
    const encoded = encode(own);
    const radio = await receiver(t, { own, reply: "answer: " + encoded });
    await radio.deliver({ seq: 1, at: new Date().toISOString(), from: "peer", text: "please answer" });
    await eventually(() => radio.posts.length > 0 || radio.entries().some((entry) => entry.text.includes("reply withheld")));
    const needle = encoded.replace(/\s/gu, "");
    assert.equal(radio.posts.some((post) => post.text.replace(/\s/gu, "").includes(needle)), false, "private material must never reach the signed POST");
    assert.ok(radio.posts.length === 0 || radio.posts.every((post) => post.text.includes("[key redacted]")), "the answer is withheld or redacted, not silently lost");
  });
}

test("receiver still signs and sends an ordinary reply", async (t) => {
  const own = identity();
  const radio = await receiver(t, { own, reply: "ordinary answer" });
  await radio.deliver({ seq: 1, at: new Date().toISOString(), from: "peer", text: "please answer" });
  await eventually(() => radio.posts.length === 1);
  assert.equal(radio.posts[0].text, "ordinary answer");
  assert.equal(verifyAgentSigned({ ...radio.posts[0], at: new Date().toISOString() }, frequency, own.publicKey).ok, true);
});

for (const transport of ["REST", "WS"]) {
  test(transport + ": valid agent authorship cannot grant or widen an operator mandate", async (t) => {
    const owner = identity();
    const peer = identity();
    const radio = await receiver(t, { channel: { operator: { key: owner.publicKey }, agents: { peer: { key: peer.publicKey } } } });
    let seq = 0;
    const send = async (from, text, key, domain, mandate) => {
      const ts = Date.now();
      const payload = [domain, frequency, from, String(ts), ...(domain === "airadio-signed-v1" ? [JSON.stringify(mandate)] : []), text].join("\n");
      const envelope = { v: 1, key: key.publicKey, ts, mandate,
        sig: sign("sha256", Buffer.from(payload), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
      const message = { seq: ++seq, at: new Date(ts).toISOString(), from, text,
        [domain === "airadio-signed-v1" ? "sig" : "agentSig"]: envelope };
      if (from === "peer") assert.equal(verifyAgentSigned(message, frequency, peer.publicKey).ok, true, "the exact mandate-attempt text has a valid peer signature");
      await radio.deliver(message, transport);
      return radio.entries().find((entry) => entry.seq === seq);
    };
    const attempted = { scope: "tools", to: "bot", until: new Date(Date.now() + 60_000).toISOString() };
    for (const existing of [false, true]) {
      if (existing) {
        const entry = await send("owner", "talk only", owner, "airadio-signed-v1", { scope: "talk", to: "bot", until: attempted.until });
        assert.equal(entry.operator, true, "operator authority remains functional");
        assert.equal(json(radio.paths.config).channels[frequency].mandate.scope, "talk");
      }
      const before = json(radio.paths.config);
      const entry = await send("peer", "agent mandate " + existing, peer, "airadio-agent-signed-v1", attempted);
      assert.equal(entry.agentVerified, true);
      assert.equal(entry.operator, undefined);
      assert.equal(entry.signer, undefined);
      assert.equal(entry.mandate, undefined);
      const after = json(radio.paths.config);
      assert.equal(JSON.stringify(after) === JSON.stringify(before), true, "a valid agent signature cannot change pins or mandates");
      await eventually(() => json(radio.paths.state).agents[frequency].pending.some((message) => message.seq === seq));
      const queued = json(radio.paths.state).agents[frequency].pending.find((message) => message.seq === seq);
      assert.equal(queued.agentVerified, true);
      assert.equal(queued.operator, undefined);
    }
  });
}
