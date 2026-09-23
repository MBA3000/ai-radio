import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as daemon from "../scripts/airadio-daemon.mjs";

test("the daemon delivers through the canonical relative file sink under the runtime directory", async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), "airadio-shared-sink-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const filePath = ".kofe/runtime/operator.jsonl";
  const outcome = await daemon.notifyOperatorInvitation(
    { callsign: "station-test", sequence: 1, from: "caller", note: "hello" },
    { env: { KOFE_WATCHDOG_REPORT_FILE: filePath }, rootDir },
  );
  assert.equal(outcome.ok, true);
  const rows = readFileSync(join(rootDir, filePath), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "airadio_invitation");
});

test("invitation delivery honors another writer's exclusive sink lock", async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), "airadio-shared-lock-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const filePath = ".kofe/runtime/shared.jsonl";
  const target = join(rootDir, filePath);
  const event = { callsign: "station", from: "peer", sequence: 1 };
  assert.equal((await daemon.notifyOperatorInvitation(event, { rootDir, env: { KOFE_WATCHDOG_REPORT_FILE: filePath } })).ok, true);
  const before = readFileSync(target, "utf8");
  writeFileSync(target + ".lock", JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.equal((await daemon.notifyOperatorInvitation(event, { rootDir, env: { KOFE_WATCHDOG_REPORT_FILE: filePath } })).ok, false);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(existsSync(target + ".lock"), true, "another writer's lock must not be removed");
  rmSync(target + ".lock");
  assert.equal((await daemon.notifyOperatorInvitation(event, { rootDir, env: { KOFE_WATCHDOG_REPORT_FILE: filePath } })).ok, true);
  assert.equal(existsSync(target + ".lock"), false);
});

test("invitation file delivery refuses unsafe targets instead of acknowledging them", async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), "airadio-sink-boundaries-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const event = { callsign: "station-test", sequence: 1, from: "caller", note: "hello" };
  const outside = join(rootDir, "outside.jsonl");
  let r = await daemon.notifyOperatorInvitation(event, { rootDir, env: { KOFE_WATCHDOG_REPORT_FILE: outside } });
  assert.equal(r.ok, false);
  assert.equal(existsSync(outside), false);
  writeFileSync(outside, "untouched\n");
  const link = join(rootDir, "link.jsonl"); symlinkSync(outside, link);
  r = await daemon.notifyOperatorInvitation(event, { env: { KOFE_WATCHDOG_SINK_FILE: link } });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(outside, "utf8"), "untouched\n");
  const full = join(rootDir, "full.jsonl"); const bytes = "x".repeat(1024 * 1024);
  writeFileSync(full, bytes);
  r = await daemon.notifyOperatorInvitation(event, { env: { KOFE_WATCHDOG_SINK_FILE: full } });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(full, "utf8"), bytes);
});

test("explicit Bearer credentials are scrubbed before invitation diagnostics", async () => {
  const result = await daemon.notifyOperatorInvitation({ callsign: "test", from: "peer", sequence: 2, note: "Authorization: Bearer a1b2c3" }, { env: {} });
  assert.doesNotMatch(result.line, /a1b2c3/u);
  assert.match(result.line, /REDACTED/u);
});

test("credential-shaped invitation text is redacted before length clipping", async () => {
  const fragment = "abcdef0123456789".repeat(2);
  const outcome = await daemon.notifyOperatorInvitation({ callsign: "s", from: "c", sequence: 1, note: "x".repeat(450) + " " + fragment.repeat(4) }, { env: {} });
  assert.ok(!outcome.line.includes(fragment));
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const callText = (frequency, key, note = "") => JSON.stringify({ type: "call", frequency, key, note });

function temporaryState(callsign = "station-test", key = "station-secret") {
  const directory = mkdtempSync(join(tmpdir(), "airadio-daemon-test-"));
  const stateFile = join(directory, "state.json");
  writeFileSync(stateFile, JSON.stringify({ callsign, key, registeredAt: "2026-09-09T00:00:00.000Z" }));
  return { directory, stateFile };
}

test("daemon HTTP client bounds the full response and refuses redirects", async () => {
  assert.equal(daemon.REQUEST_TIMEOUT_MS, 10_000);
  let redirect;
  const hangingBodyFetch = async (_url, options) => {
    redirect = options.redirect;
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
    return new Response(body, { status: 200 });
  };
  await assert.rejects(
    daemon.requestJson("https://station.example/health", {}, { fetch: hangingBodyFetch, timeoutMs: 10, maxResponseBytes: 64 }),
    /request timeout/u,
  );
  assert.equal(redirect, "error");

  await assert.rejects(
    daemon.requestJson("https://station.example/health", {}, {
      fetch: async () => jsonResponse({ padding: "x".repeat(100) }),
      timeoutMs: 100,
      maxResponseBytes: 32,
    }),
    /response exceeds 32 bytes/u,
  );
});

test("startup consumes a legacy page of 200 fully escaped 16 KiB messages within its bounded cap", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const rawTextBytes = 16 * 1024;
  const messages = Array.from({ length: 200 }, (_, index) => ({
    seq: index + 1,
    at: "2026-09-09T00:00:00.000Z",
    from: "caller-" + (index + 1),
    text: "\u0000".repeat(rawTextBytes),
  }));
  const body = JSON.stringify({ messages, last: 200 });
  const responseBytes = Buffer.byteLength(body);
  assert.ok(responseBytes > 8 * 1024 * 1024, "the fixture exercises worst-case JSON escaping, not only raw text size");
  assert.ok(responseBytes < 24 * 1024 * 1024, "the legitimate legacy page remains below the documented hard bound");

  const reads = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    reads.push(url);
    response.writeHead(200, { "content-type": "application/json", "content-length": responseBytes });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const state = await daemon.ensureRegistered(
    { url: "http://127.0.0.1:" + server.address().port, callsign: "station-test", stateFile },
    () => {},
  );

  assert.equal(state.key, "station-secret");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].searchParams.get("since"), "0");
  assert.equal(reads[0].searchParams.get("limit"), "50");
});

test("daemon configuration accepts only a fixed HTTP or HTTPS endpoint", () => {
  assert.equal(daemon.daemonConfig(["http://localhost:8787/", "station-test", "/tmp/state"], {}).url, "http://localhost:8787");
  for (const endpoint of ["ftp://station.example", "https://user:secret@station.example", "https://station.example/path", "not a url"]) {
    assert.throws(() => daemon.daemonConfig([endpoint, "station-test", "/tmp/state"], {}), /HTTP or HTTPS endpoint/u);
  }
});

test("runDaemon has finite zero-tick control for tests", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "airadio-daemon-empty-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let fetched = false;
  await daemon.runDaemon(
    { url: "http://127.0.0.1:1", callsign: "station-test", stateFile: join(directory, "state.json") },
    () => {},
    { maxTicks: 0, fetch: async () => { fetched = true; throw new Error("must not fetch"); } },
  );
  assert.equal(fetched, false);
});

test("real daemon tick aborts a mailbox response body at the deadline", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const logs = [];
  let mailboxReads = 0;
  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if (!url.pathname.endsWith("/calls")) throw new Error("unexpected request");
    mailboxReads += 1;
    if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    options.signal.addEventListener("abort", () => controller.error(new Error("leaked station-secret")), { once: true });
    return new Response(body, { status: 200 });
  };

  await daemon.runDaemon(
    { url: "https://station.example", callsign: "station-test", stateFile },
    (line) => logs.push(line),
    { fetch, maxTicks: 1, timeoutMs: 10 },
  );

  assert.ok(logs.some((line) => line.includes("request timeout")));
  assert.ok(logs.every((line) => !line.includes("station-secret")));
});

test("daemon retries a failed call announcement without losing the later call", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const frequencyA = "fm-aaaaaaaaaaaaaaaa";
  const frequencyB = "fm-bbbbbbbbbbbbbbbb";
  const keyA = "c".repeat(16);
  const keyB = "d".repeat(16);
  const inboxSince = [];
  const announcements = [];
  let mailboxReads = 0;
  let firstAnnouncementAttempts = 0;

  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const method = options.method ?? "GET";
    if (url.pathname.endsWith("/calls")) {
      inboxSince.push(url.searchParams.get("since"));
      mailboxReads += 1;
      if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
      return jsonResponse({
        messages: [
          { seq: 1, from: "caller-a", text: callText(frequencyA, keyA) },
          { seq: 2, from: "caller-b", text: callText(frequencyB, keyB) },
        ],
        last: 2,
      });
    }
    if (method === "POST" && url.pathname.endsWith("/send")) {
      const frequency = url.pathname.split("/").at(-2);
      announcements.push(frequency);
      if (frequency === frequencyA && firstAnnouncementAttempts++ === 0) {
        let controller;
        const body = new ReadableStream({ start(value) { controller = value; } });
        options.signal.addEventListener("abort", () => controller.error(new Error("transport leaked " + keyA)), { once: true });
        return new Response(body, { status: 200 });
      }
      return jsonResponse({ seq: announcements.length });
    }
    if (url.pathname.endsWith("/messages")) return jsonResponse({ messages: [], last: 0 });
    throw new Error("unexpected request");
  };

  const logs = [];
  await daemon.runDaemon(
    { url: "https://station.example", callsign: "station-test", stateFile },
    (line) => logs.push(line),
    { fetch, autoAcceptInvitationsForTest: true, notifyInvitation: async () => ({ line: "test invitation" }), maxTicks: 2, sleep: async () => {}, timeoutMs: 10, now: () => 1_000 },
  );

  assert.deepEqual(inboxSince, ["0", "0", "2"], "the cursor acknowledges the page while the failed call remains pending");
  assert.deepEqual(announcements, [frequencyA, frequencyB, frequencyA], "a later call runs in the same tick and the failed call recovers next tick");
  assert.ok(logs.some((line) => line.includes("request timeout") && line.includes("retry on a later tick") && line.includes("delivery may be uncertain")));
  assert.ok(logs.every((line) => !line.includes(keyA) && !line.includes(keyB)), "a transport error cannot expose invitation keys");
});

test("persistent 403 and 404 call failures are acknowledged while later calls process", async (context) => {
  for (const status of [403, 404]) {
    const { directory, stateFile } = temporaryState();
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const badFrequency = "fm-aaaaaaaaaaaaaaaa";
    const goodFrequency = "fm-bbbbbbbbbbbbbbbb";
    const badKey = "c".repeat(16);
    const goodKey = "d".repeat(16);
    const inboxSince = [];
    const sendAttempts = [];
    const logs = [];
    let mailboxReads = 0;

    const fetch = async (rawUrl, options) => {
      const url = new URL(rawUrl);
      const method = options.method ?? "GET";
      if (url.pathname.endsWith("/calls")) {
        inboxSince.push(url.searchParams.get("since"));
        mailboxReads += 1;
        if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
        if (url.searchParams.get("since") === "0") return jsonResponse({ messages: [
          { seq: 1, from: "caller-bad", text: callText(badFrequency, badKey) },
          { seq: 2, from: "caller-good", text: callText(goodFrequency, goodKey) },
        ], last: 2 });
        return jsonResponse({ messages: [], last: 2 });
      }
      if (method === "POST" && url.pathname.endsWith("/send")) {
        const frequency = url.pathname.split("/").at(-2);
        sendAttempts.push(frequency);
        return frequency === badFrequency ? jsonResponse({ error: "refused" }, status) : jsonResponse({ seq: 1 });
      }
      if (url.pathname.endsWith("/messages")) return jsonResponse({ messages: [], last: 0 });
      throw new Error("unexpected request");
    };

    await daemon.runDaemon(
      { url: "https://station.example", callsign: "station-test", stateFile },
      (line) => logs.push(line),
      { fetch, autoAcceptInvitationsForTest: true, notifyInvitation: async () => ({ line: "test invitation" }), maxTicks: 2, sleep: async () => {}, timeoutMs: 100, now: () => 1_000 },
    );

    assert.deepEqual(inboxSince, ["0", "0", "2"]);
    assert.equal(sendAttempts.filter((frequency) => frequency === badFrequency).length, 1, "HTTP " + status + " is terminal");
    assert.equal(sendAttempts.filter((frequency) => frequency === goodFrequency).length, 1, "the later call is processed in the same tick");
    assert.ok(logs.some((line) => line.includes("HTTP " + status) && line.includes("acknowledged without retry")));
    assert.ok(logs.every((line) => !line.includes(badKey) && !line.includes(goodKey)), "private keys are never logged");
  }
});

test("permanent HTTP 500 call failure exhausts after three ticks with an explicit outcome", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const frequency = "fm-aaaaaaaaaaaaaaaa";
  const privateKey = "c".repeat(16);
  const logs = [];
  const inboxSince = [];
  let mailboxReads = 0;
  let sendAttempts = 0;

  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const method = options.method ?? "GET";
    if (url.pathname.endsWith("/calls")) {
      inboxSince.push(url.searchParams.get("since"));
      mailboxReads += 1;
      if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
      if (url.searchParams.get("since") === "0") return jsonResponse({
        messages: [{ seq: 1, from: "caller-a", text: callText(frequency, privateKey) }],
        last: 1,
      });
      return jsonResponse({ messages: [], last: 1 });
    }
    if (method === "POST" && url.pathname.endsWith("/send")) {
      sendAttempts += 1;
      return jsonResponse({ error: "temporary" }, 500);
    }
    throw new Error("unexpected request");
  };

  await daemon.runDaemon(
    { url: "https://station.example", callsign: "station-test", stateFile },
    (line) => logs.push(line),
    { fetch, autoAcceptInvitationsForTest: true, notifyInvitation: async () => ({ line: "test invitation" }), maxTicks: 4, sleep: async () => {}, timeoutMs: 100, now: () => 1_000 },
  );

  assert.equal(sendAttempts, 3, "the fourth tick does not retry an exhausted call");
  assert.deepEqual(inboxSince, ["0", "0", "1", "1", "1"]);
  assert.ok(logs.some((line) => line.includes("exhausted after 3 attempts") && line.includes("acknowledged")));
  assert.ok(logs.every((line) => !line.includes(privateKey)), "the failed invitation key is never logged");
});

test("an already tuned channel is polled when another call and then the mailbox fail", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const tunedFrequency = "fm-aaaaaaaaaaaaaaaa";
  const failedFrequency = "fm-bbbbbbbbbbbbbbbb";
  const tunedKey = "c".repeat(16);
  const failedKey = "d".repeat(16);
  const channelReads = [];
  const logs = [];
  let mailboxReads = 0;

  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const method = options.method ?? "GET";
    if (url.pathname.endsWith("/calls")) {
      mailboxReads += 1;
      if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
      if (mailboxReads === 2) return jsonResponse({
        messages: [{ seq: 1, from: "caller-good", text: callText(tunedFrequency, tunedKey) }],
        last: 1,
      });
      if (mailboxReads === 3) return jsonResponse({
        messages: [{ seq: 2, from: "caller-failed", text: callText(failedFrequency, failedKey) }],
        last: 2,
      });
      throw new Error("mailbox transport leaked " + failedKey);
    }
    if (method === "POST" && url.pathname.endsWith("/send")) {
      const frequency = url.pathname.split("/").at(-2);
      return frequency === failedFrequency ? jsonResponse({ error: "temporary" }, 500) : jsonResponse({ seq: 1 });
    }
    if (url.pathname.endsWith("/messages")) {
      channelReads.push(url.pathname.split("/").at(-2));
      return jsonResponse({ messages: [], last: 0 });
    }
    throw new Error("unexpected request");
  };

  await daemon.runDaemon(
    { url: "https://station.example", callsign: "station-test", stateFile },
    (line) => logs.push(line),
    { fetch, autoAcceptInvitationsForTest: true, notifyInvitation: async () => ({ line: "test invitation" }), maxTicks: 3, sleep: async () => {}, timeoutMs: 100, now: () => 1_000 },
  );

  assert.deepEqual(channelReads, [tunedFrequency, tunedFrequency, tunedFrequency], "channel polling survives both another call's failure and a mailbox transport error");
  assert.ok(logs.some((line) => line.includes("mailbox poll failed: request failed")));
  assert.ok(logs.every((line) => !line.includes(tunedKey) && !line.includes(failedKey)), "neither channel key reaches logs");
});

test("one channel failure does not suppress another channel and logs stay single-line", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const frequencyA = "fm-aaaaaaaaaaaaaaaa";
  const frequencyB = "fm-bbbbbbbbbbbbbbbb";
  const keyA = "c".repeat(16);
  const keyB = "d".repeat(16);
  const channelReads = [];
  const logs = [];
  let mailboxReads = 0;

  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const method = options.method ?? "GET";
    if (url.pathname.endsWith("/calls")) {
      mailboxReads += 1;
      if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
      return jsonResponse({ messages: [
        { seq: 1, from: "caller-a", text: callText(frequencyA, keyA) },
        { seq: 2, from: "caller-b", text: callText(frequencyB, keyB, "line\nFORGED") },
      ], last: 2 });
    }
    if (method === "POST" && url.pathname.endsWith("/send")) return jsonResponse({ seq: 1 });
    if (url.pathname.endsWith("/messages")) {
      const frequency = url.pathname.split("/").at(-2);
      channelReads.push(frequency);
      if (frequency === frequencyA) throw new Error("transport leaked " + keyA);
      return jsonResponse({ messages: [{ seq: 1, from: "sender\nFORGED", text: "hello\r\nFORGED" }], last: 1 });
    }
    throw new Error("unexpected request");
  };

  await daemon.runDaemon(
    { url: "https://station.example", callsign: "station-test", stateFile },
    (line) => logs.push(line),
    { fetch, autoAcceptInvitationsForTest: true, notifyInvitation: async () => ({ line: "test invitation" }), maxTicks: 1, timeoutMs: 100, now: () => 1_000 },
  );

  assert.deepEqual(channelReads, [frequencyA, frequencyB]);
  assert.ok(logs.some((line) => line.includes("hello\\r\\nFORGED")), "control characters are escaped, not emitted");
  assert.ok(logs.every((line) => !line.includes("\n") && !line.includes("\r")), "every event remains one physical log line");
  assert.ok(logs.every((line) => !line.includes(keyA) && !line.includes(keyB)), "errors and events do not echo keys");
});

test("stored station key refusal preserves identity and never re-registers", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = readFileSync(stateFile, "utf8");

  for (const status of [403, 500]) {
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, method: options.method ?? "GET" });
      return jsonResponse({ error: "do not echo station-secret" }, status);
    };
    await assert.rejects(
      daemon.ensureRegistered(
        { url: "https://station.example", callsign: "station-test", stateFile },
        () => {},
        { fetch, timeoutMs: 100 },
      ),
      (error) => {
        assert.match(error.message, new RegExp("HTTP " + status));
        assert.match(error.message, /state preserved/u);
        assert.doesNotMatch(error.message, /station-secret/u);
        return true;
      },
    );
    assert.deepEqual(calls.map((call) => call.method), ["GET"], "a refused stored key must not trigger POST registration");
    assert.equal(readFileSync(stateFile, "utf8"), before);
  }
});

test("a valid invitation notifies the operator exactly once and is never auto-accepted", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const privateKey = "c".repeat(128);
  const notifications = [];
  const requests = [];
  let mailboxReads = 0;
  const fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    requests.push({ path: url.pathname, method: options.method ?? "GET" });
    if (!url.pathname.endsWith("/calls")) throw new Error("the daemon must not join or send automatically");
    mailboxReads += 1;
    if (mailboxReads === 1) return jsonResponse({ messages: [], last: 0 });
    return jsonResponse({ messages: [{
      seq: 7,
      from: "caller-safe",
      text: callText("fm-aaaaaaaaaaaaaaaa", privateKey, "Please answer from ask"),
    }], last: 7 });
  };
  const logs = [];
  await daemon.runDaemon(
    { url: "https://station.example", callsign: "station-test", stateFile },
    (line) => logs.push(line),
    {
      fetch,
      maxTicks: 1,
      notifyInvitation: async (event) => {
        notifications.push(event);
        return { ok: true, line: "invitation received; operator notification recorded" };
      },
    },
  );
  assert.deepEqual(notifications, [{ callsign: "station-test", sequence: 7, from: "caller-safe", note: "Please answer from ask" }]);
  assert.deepEqual(requests.map((request) => request.path), [
    "/v1/station/station-test/calls",
    "/v1/station/station-test/calls",
  ]);
  assert.ok(logs.some((line) => line.includes("invitation received")));
  assert.ok(logs.every((line) => !line.includes(privateKey) && !line.includes("fm-aaaaaaaaaaaaaaaa")));
});

test("an invitation is explicitly visible when no operator notification sink exists", async () => {
  const outcome = await daemon.notifyOperatorInvitation(
    { callsign: "station-test", sequence: 4, from: "caller-safe", note: "hello" },
    { env: {}, now: () => Date.parse("2026-09-09T00:00:00.000Z") },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.line, /invitation received/iu);
  assert.match(outcome.line, /no operator notification sink/iu);
});

test("the watchdog-compatible invitation sink is private, bounded data and redacts credential-shaped note text", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "airadio-notify-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sink = join(directory, "watchdog.jsonl");
  const credential = "a".repeat(128);
  const outcome = await daemon.notifyOperatorInvitation(
    { callsign: "station-test", sequence: 8, from: "caller-safe", note: `reflected ${credential}` },
    { env: { KOFE_WATCHDOG_SINK_FILE: sink }, now: () => Date.parse("2026-09-09T00:00:00.000Z") },
  );
  assert.equal(outcome.ok, true);
  assert.equal(statSync(sink).mode & 0o777, 0o600);
  const text = readFileSync(sink, "utf8");
  assert.doesNotMatch(text, new RegExp(credential, "u"));
  const row = JSON.parse(text);
  assert.equal(row.kind, "airadio_invitation");
  assert.equal(row.ok, true);
  assert.deepEqual(row.lines.length, 1);
});

test("operator-requested daemon rotation replaces the stored key without registration", async (context) => {
  const { directory, stateFile } = temporaryState();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const nextKey = "e".repeat(128);
  const calls = [];
  const state = await daemon.ensureRegistered(
    { url: "https://station.example", callsign: "station-test", stateFile, rotateKey: true },
    () => {},
    {
      fetch: async (rawUrl, options) => {
        const url = new URL(rawUrl);
        calls.push({ path: url.pathname, method: options.method ?? "GET", wave: options.headers?.["X-Wave"] });
        if (url.pathname.endsWith("/calls")) return jsonResponse({ messages: [], last: 0 });
        if (url.pathname.endsWith("/rotate")) return jsonResponse({ callsign: "station-test", key: nextKey });
        throw new Error("unexpected request");
      },
    },
  );
  assert.equal(state.key, nextKey);
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["GET", "/v1/station/station-test/calls"],
    ["POST", "/v1/station/station-test/rotate"],
  ]);
  assert.equal(calls[1].wave, "station-secret");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).key, nextKey);
});
