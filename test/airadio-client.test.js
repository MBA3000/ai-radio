/**
 * Exercise the adapter's fixed-origin HTTP boundary: validated route parts,
 * redirect refusal, deadlines through body reads, explicit response bounds,
 * response validation, and remote-error sanitization.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { AiradioHttpError, createAiradioClient, parseAiradioOrigin } from "../src/airadio-client.js";

const ORIGIN = "https://airadio.akbrd.com";
const KEY = "a".repeat(128);
const WAVE = "b".repeat(128);

/** A fetch double that records its calls and answers from a queue. */
function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected extra request to ${url}`);
    if (typeof next === "function") return next(String(url), options);
    return next;
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (body, status = 200) =>
  new Response(`${JSON.stringify(body)}\n`, { status, headers: { "content-type": "application/json; charset=utf-8" } });

const clientWith = (fetchImpl, options = {}) =>
  createAiradioClient({ origin: ORIGIN, fetchImpl, timeoutMs: 50, ...options });

/** A real HTTP peer that completes headers, then keeps the JSON body open. */
async function startBodyStallServer(t) {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.flushHeaders();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("body-stall server did not bind TCP");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${address.port}`;
}

test("one deadline bounds real HTTP headers and a body that stalls after them", async (t) => {
  const origin = await startBodyStallServer(t);
  const client = createAiradioClient({ origin, allowLocalHttp: true, timeoutMs: 40 });
  const result = await Promise.race([
    client.health().then(
      () => "unexpected-success",
      (error) => (error instanceof AiradioHttpError ? error.code : "unexpected-error"),
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending-after-225ms"), 225)),
  ]);
  assert.equal(result, "timeout", "headers must not clear the deadline while the body is still unread");
});

test("an origin is accepted only when it is a bare HTTPS origin", () => {
  assert.equal(parseAiradioOrigin("https://airadio.akbrd.com"), "https://airadio.akbrd.com");
  assert.equal(parseAiradioOrigin("https://airadio.akbrd.com/"), "https://airadio.akbrd.com", "a bare trailing slash is a bare origin");
  assert.equal(parseAiradioOrigin("https://radio.example.org:8443"), "https://radio.example.org:8443", "operator-chosen HTTPS origins are permitted");

  for (const bad of [
    "http://airadio.akbrd.com",
    "https://user:pass@airadio.akbrd.com",
    "https://airadio.akbrd.com/v1",
    "https://airadio.akbrd.com/?a=1",
    "https://airadio.akbrd.com/#frag",
    "ftp://airadio.akbrd.com",
    "file:///etc/passwd",
    "not a url",
    "",
    null,
  ]) {
    assert.throws(
      () => parseAiradioOrigin(bad),
      (error) => error instanceof AiradioHttpError && error.code === "bad-origin",
      `must refuse origin: ${String(bad)}`,
    );
  }
});

test("plain HTTP is available for local testing only, and only on loopback", () => {
  assert.equal(parseAiradioOrigin("http://127.0.0.1:8787", { allowLocalHttp: true }), "http://127.0.0.1:8787");
  assert.equal(parseAiradioOrigin("http://localhost:8787", { allowLocalHttp: true }), "http://localhost:8787");
  assert.equal(parseAiradioOrigin("http://[::1]:8787", { allowLocalHttp: true }), "http://[::1]:8787");
  for (const bad of ["http://airadio.akbrd.com", "http://10.0.0.5:8787", "http://example.com"]) {
    assert.throws(
      () => parseAiradioOrigin(bad, { allowLocalHttp: true }),
      (error) => error instanceof AiradioHttpError && error.code === "bad-origin",
      `--allow-local-http must not open the whole internet: ${bad}`,
    );
  }
});

test("every request is composed from the fixed origin, refuses redirects, and carries an abort signal", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ ok: true, service: "airadio", at: "2026-09-09T00:00:00.000Z" })]);
  const client = clientWith(fetchImpl);
  const health = await client.health();
  assert.deepEqual(health, { ok: true, service: "airadio", at: "2026-09-09T00:00:00.000Z" });

  const [call] = fetchImpl.calls;
  assert.equal(call.url, `${ORIGIN}/health`);
  assert.equal(call.options.redirect, "error", "a redirect must never forward X-Wave to another origin");
  assert.equal(call.options.cache, "no-store");
  assert.ok(call.options.signal, "every request carries a deadline signal");
});

test("callsign and frequency are validated before they can reach a URL", async () => {
  const fetchImpl = recordingFetch([]);
  const client = clientWith(fetchImpl);
  for (const bad of ["../../etc", "UPPER", "a", "x".repeat(40), "has space", "a/b"]) {
    await assert.rejects(
      () => client.registerStation(bad),
      (error) => error instanceof AiradioHttpError && error.code === "bad-callsign",
      `callsign must be refused before fetch: ${bad}`,
    );
  }
  for (const bad of ["fm-XYZ", "fm-", "notfm-abcdef0123456789", "fm-abcdef0123456789/../x"]) {
    await assert.rejects(
      () => client.readChannel({ channelId: bad, wave: WAVE }),
      (error) => error instanceof AiradioHttpError && error.code === "bad-channel-id",
      `frequency must be refused before fetch: ${bad}`,
    );
  }
  assert.equal(fetchImpl.calls.length, 0, "nothing invalid may reach the network at all");
});

test("registration returns the public identity and the key, and stores nothing itself", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ callsign: "alpha-one", key: KEY, note: "shown once" })]);
  const client = clientWith(fetchImpl);
  const result = await client.registerStation("alpha-one");
  assert.deepEqual(result, { callsign: "alpha-one", key: KEY });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `${ORIGIN}/v1/station`);
  assert.equal(call.options.method, "POST");
  assert.deepEqual(JSON.parse(call.options.body), { callsign: "alpha-one" });
});

test("channel creation returns the public frequency and the once-shown wave", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ frequency: "fm-abcdef0123456789", wave: WAVE, sha512: { wave: "x" }, note: "once" })]);
  const client = clientWith(fetchImpl);
  const created = await client.createChannel();
  assert.deepEqual(created, { channelId: "fm-abcdef0123456789", wave: WAVE });
  assert.equal(fetchImpl.calls[0].url, `${ORIGIN}/v1/channel`);
  assert.equal(fetchImpl.calls[0].options.method, "POST");
});

test("a send presents the wave in the header and never in the URL or the body", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ seq: 4 })]);
  const client = clientWith(fetchImpl);
  const sent = await client.sendChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, from: "alpha-one", text: "hello" });
  assert.deepEqual(sent, { sequence: 4 });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `${ORIGIN}/v1/channel/fm-abcdef0123456789/send`);
  assert.equal(call.options.headers["X-Wave"], WAVE);
  assert.equal(call.url.includes(WAVE), false);
  assert.deepEqual(JSON.parse(call.options.body), { from: "alpha-one", text: "hello" });
});

test("message text is bounded in UTF-8 BYTES before it is sent", async () => {
  const fetchImpl = recordingFetch([]);
  const client = clientWith(fetchImpl);
  await assert.rejects(
    () => client.sendChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, from: "alpha-one", text: "\u00e9".repeat(9000) }),
    (error) => error instanceof AiradioHttpError && error.code === "text-too-large",
    "9000 two-byte characters are 17 KiB, over the station's 16 KiB rule",
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("a read slices to the requested limit and reports a cursor that cannot skip a message", async () => {
  // The DEPLOYED worker has no `limit` parameter: it answers with up to 200 rows
  // and a `last` that belongs to the LAST ROW IT SENT, not to the last row the
  // caller kept. Trusting `last` after a local slice would silently drop
  // messages, so the cursor must be the last row actually returned.
  const rows = Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, at: "2026-09-09T00:00:00.000Z", from: "beta-two", text: `m${index + 1}` }));
  const fetchImpl = recordingFetch([jsonResponse({ messages: rows, last: 5 })]);
  const client = clientWith(fetchImpl);
  const page = await client.readChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, since: 0, limit: 2 });
  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2]);
  assert.equal(page.nextSince, 2, "the cursor is the last row KEPT, never the upstream `last`");
  assert.equal(page.hasMore, true);
  assert.match(fetchImpl.calls[0].url, /\/v1\/channel\/fm-abcdef0123456789\/messages\?since=0&limit=2$/u);
  assert.equal(fetchImpl.calls[0].options.headers["X-Wave"], WAVE);
});

test("a read of a server that honours the limit reports no more work to do", async () => {
  const rows = [{ seq: 7, at: "2026-09-09T00:00:00.000Z", from: "beta-two", text: "only one" }];
  const fetchImpl = recordingFetch([jsonResponse({ messages: rows, last: 7, hasMore: false })]);
  const client = clientWith(fetchImpl);
  const page = await client.readChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, since: 6, limit: 5 });
  assert.deepEqual(page.messages.map((m) => m.seq), [7]);
  assert.equal(page.nextSince, 7);
  assert.equal(page.hasMore, false);
});

test("`since` must be a non-negative safe integer", async () => {
  const fetchImpl = recordingFetch([]);
  const client = clientWith(fetchImpl);
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "3"]) {
    await assert.rejects(
      () => client.readChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, since: bad }),
      (error) => error instanceof AiradioHttpError && error.code === "bad-since",
      `since must be refused: ${String(bad)}`,
    );
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("the mailbox is read with the station key, and a call is placed without one", async () => {
  const fetchImpl = recordingFetch([
    jsonResponse({ messages: [{ seq: 2, at: "2026-09-09T00:00:00.000Z", from: "beta-two", text: "{}" }], last: 2 }),
    jsonResponse({ seq: 9 }),
  ]);
  const client = clientWith(fetchImpl);

  const mailbox = await client.readMailbox({ callsign: "alpha-one", key: KEY, since: 1, limit: 10 });
  assert.deepEqual(mailbox.messages.map((m) => m.seq), [2]);
  assert.match(fetchImpl.calls[0].url, /\/v1\/station\/alpha-one\/calls\?since=1&limit=10$/u);
  assert.equal(fetchImpl.calls[0].options.headers["X-Wave"], KEY);

  const placed = await client.callStation({ callsign: "beta-two", from: "alpha-one", text: "{\"type\":\"call\"}" });
  assert.deepEqual(placed, { sequence: 9 });
  assert.equal(fetchImpl.calls[1].url, `${ORIGIN}/v1/station/beta-two/call`);
  assert.equal(fetchImpl.calls[1].options.headers["X-Wave"], undefined, "a call is an OPEN send — a callsign is a phone number");
});

test("presence is public and its shape is validated", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ registered: true, onAir: false, lastSeen: "2026-09-09T00:00:00.000Z" })]);
  const client = clientWith(fetchImpl);
  const presence = await client.presence("beta-two");
  assert.deepEqual(presence, { registered: true, onAir: false, lastSeen: "2026-09-09T00:00:00.000Z" });
  assert.equal(fetchImpl.calls[0].url, `${ORIGIN}/v1/station/beta-two`);
});

test("a remote failure is reported by status alone; the raw remote body never comes back", async () => {
  const fetchImpl = recordingFetch([
    jsonResponse({ error: "wrong wave", secretEcho: `${WAVE}` }, 403),
  ]);
  const client = clientWith(fetchImpl);
  await assert.rejects(
    () => client.readChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, since: 0 }),
    (error) => {
      assert.ok(error instanceof AiradioHttpError);
      assert.equal(error.code, "http-status");
      assert.equal(error.status, 403);
      assert.equal(error.message.includes(WAVE), false, "an error must not echo a secret back");
      assert.equal(error.message.includes("secretEcho"), false, "a raw remote body is not an adapter error message");
      return true;
    },
  );
});

test("a redirect, a timeout, and a transport failure are distinct honest errors", async () => {
  const redirecting = recordingFetch([
    () => {
      const error = new TypeError("fetch failed: unexpected redirect");
      error.cause = new Error("redirect count exceeded");
      throw error;
    },
  ]);
  await assert.rejects(
    () => clientWith(redirecting).health(),
    (error) => error instanceof AiradioHttpError && error.code === "network",
  );

  const hanging = recordingFetch([
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  ]);
  await assert.rejects(
    () => createAiradioClient({ origin: ORIGIN, fetchImpl: hanging, timeoutMs: 10 }).health(),
    (error) => error instanceof AiradioHttpError && error.code === "timeout",
    "a hung station must become a bounded timeout, never a hung adapter",
  );
});

test("a response that is not bounded JSON of the expected shape is refused, not guessed at", async () => {
  const notJson = recordingFetch([new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } })]);
  await assert.rejects(
    () => clientWith(notJson).health(),
    (error) => error instanceof AiradioHttpError && error.code === "bad-content-type",
  );

  const brokenJson = recordingFetch([new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } })]);
  await assert.rejects(
    () => clientWith(brokenJson).health(),
    (error) => error instanceof AiradioHttpError && error.code === "bad-response",
  );

  const wrongShape = recordingFetch([jsonResponse({ frequency: "not-a-frequency", wave: WAVE })]);
  await assert.rejects(
    () => clientWith(wrongShape).createChannel(),
    (error) => error instanceof AiradioHttpError && error.code === "bad-response",
    "a creation body that does not match the protocol is a failure, not a channel",
  );

  const wrongRows = recordingFetch([jsonResponse({ messages: [{ seq: "one", text: 5 }], last: 1 })]);
  await assert.rejects(
    () => clientWith(wrongRows).readChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, since: 0 }),
    (error) => error instanceof AiradioHttpError && error.code === "bad-response",
  );
});

test("an over-large response is cut off honestly rather than read into memory", async () => {
  const huge = "x".repeat(4096);
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(huge));
    },
  });
  const fetchImpl = recordingFetch([new Response(stream, { status: 200, headers: { "content-type": "application/json" } })]);
  await assert.rejects(
    () => createAiradioClient({ origin: ORIGIN, fetchImpl, timeoutMs: 2000, maxResponseBytes: 32 * 1024 }).health(),
    (error) => error instanceof AiradioHttpError && error.code === "response-too-large",
    "an overflow is surfaced; it is never reported as an empty read",
  );
});

test("the default response bound still admits a full 200-message page of 16 KiB messages", () => {
  const client = clientWith(recordingFetch([]));
  assert.ok(
    client.maxResponseBytes >= 4 * 1024 * 1024,
    `the deployed worker can answer 200 x 16 KiB; the cap is ${client.maxResponseBytes} bytes`,
  );
});

test("a failed POST is never blindly retried — a retry would duplicate a relay message", async () => {
  const fetchImpl = recordingFetch([jsonResponse({ error: "boom" }, 500)]);
  const client = clientWith(fetchImpl);
  await assert.rejects(
    () => client.sendChannel({ channelId: "fm-abcdef0123456789", wave: WAVE, from: "alpha-one", text: "hello" }),
    (error) => error instanceof AiradioHttpError && error.status === 500,
  );
  assert.equal(fetchImpl.calls.length, 1, "exactly one POST attempt");
});
