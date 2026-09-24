/**
 * The MCP adapter's network boundary.
 *
 * The operator selects one origin at launch. Tool calls supply only validated
 * protocol identifiers, never an arbitrary URL, method, path, or header.
 * Requests refuse redirects and retain a deadline through response-body reads.
 * An 8 MiB response cap reports overflow explicitly; highly escaped legacy
 * 200-row pages can exceed it. New relays honor the adapter's smaller page size.
 * Remote error bodies are not returned to the caller. POSTs are not retried
 * automatically because the relay has no idempotency-key contract.
 */

const CALLSIGN_SHAPE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u;
const FREQUENCY_SHAPE = /^fm-[a-f0-9]{8,64}$/u;
const WAVE_SHAPE = /^[a-f0-9]{16,128}$/u;

const MAX_TEXT_BYTES = 16 * 1024;
/** 200 messages x 16 KiB is what the deployed worker can already answer. */
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const encoder = new TextEncoder();

export class AiradioHttpError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "AiradioHttpError";
    this.code = code;
    if (status !== null) this.status = status;
  }
}

/**
 * Parse the operator's base URL into a bare origin, or refuse it.
 *
 * A bare origin only: userinfo (`https://user:pass@host`) would put a
 * credential in every request line, and a path, query or fragment would let a
 * launch-time value quietly prefix routes the adapter believes it controls.
 */
export function parseAiradioOrigin(value, { allowLocalHttp = false } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AiradioHttpError("bad-origin", "the Airadio base URL must be a non-empty string");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AiradioHttpError("bad-origin", "the Airadio base URL is not a URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AiradioHttpError("bad-origin", "the Airadio base URL must carry no userinfo");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AiradioHttpError("bad-origin", "the Airadio base URL must carry no query or fragment");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new AiradioHttpError("bad-origin", "the Airadio base URL must be a bare origin with no path");
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:") {
    if (!allowLocalHttp) {
      throw new AiradioHttpError("bad-origin", "plain HTTP needs --allow-local-http and a loopback host");
    }
    if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(`[${url.hostname}]`)) {
      throw new AiradioHttpError("bad-origin", "--allow-local-http permits loopback hosts only");
    }
    return url.origin;
  }
  throw new AiradioHttpError("bad-origin", "the Airadio base URL must be https (or loopback http for local tests)");
}

const requireCallsign = (value) => {
  if (typeof value !== "string" || !CALLSIGN_SHAPE.test(value)) {
    throw new AiradioHttpError("bad-callsign", "a callsign is 3..32 characters of a-z, 0-9 and dashes");
  }
  return value;
};

const requireChannelId = (value) => {
  if (typeof value !== "string" || !FREQUENCY_SHAPE.test(value)) {
    throw new AiradioHttpError("bad-channel-id", "a channel id looks like fm-<8..64 hex>");
  }
  return value;
};

const requireSince = (value) => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AiradioHttpError("bad-since", "since must be a non-negative safe integer");
  }
  return value;
};

const requireWave = (value) => {
  if (typeof value !== "string" || !WAVE_SHAPE.test(value)) {
    throw new AiradioHttpError("bad-wave", "a stored credential is not in the expected shape");
  }
  return value;
};

/** One message row as the protocol defines it, or nothing. */
function normalizeRow(row) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  if (!Number.isSafeInteger(row.seq) || row.seq < 0) return null;
  if (typeof row.text !== "string") return null;
  return {
    seq: row.seq,
    at: typeof row.at === "string" ? row.at : "",
    from: typeof row.from === "string" ? row.from : "",
    text: row.text,
  };
}

/**
 * A bounded page from a `messages` route.
 *
 * A station may answer more rows than asked for (an older worker ignored
 * `limit` and sent up to 200) with a `last` that names the last row IT sent.
 * Trusting that `last` after slicing locally would skip every message between
 * the slice and the upstream end, so the cursor is always the last row actually
 * KEPT. The current worker honours `limit` and says `hasMore`: then the slice is
 * a no-op and `hasMore` comes from the server.
 */
function normalizePage(body, limit) {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages)) {
    throw new AiradioHttpError("bad-response", "the station did not answer with a message page");
  }
  const rows = [];
  for (const raw of body.messages) {
    const row = normalizeRow(raw);
    if (row === null) throw new AiradioHttpError("bad-response", "the station returned a message that is not in protocol shape");
    rows.push(row);
  }
  rows.sort((left, right) => left.seq - right.seq);

  const capped = typeof limit === "number" ? rows.slice(0, limit) : rows;
  const truncatedLocally = capped.length < rows.length;
  const serverSaysMore = body.hasMore === true;
  const last = capped.length > 0 ? capped[capped.length - 1].seq : null;

  return {
    messages: capped,
    // Never the upstream `last` when we cut the page: that is how messages get
    // skipped and never seen again on a relay that is not an archive.
    nextSince: last !== null ? last : requireSince(body.last === undefined ? 0 : (Number.isSafeInteger(body.last) ? body.last : 0)),
    hasMore: truncatedLocally || serverSaysMore,
  };
}

/**
 * Create the client. `fetchImpl` is injected so every property above can be
 * proved without a network, and so the adapter can be tested hermetically.
 */
export function createAiradioClient({
  origin,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowLocalHttp = false,
} = {}) {
  const base = parseAiradioOrigin(origin, { allowLocalHttp });
  if (typeof fetchImpl !== "function") {
    throw new AiradioHttpError("bad-config", "no fetch implementation is available");
  }

  /** Race one pending operation against the request's one absolute deadline. */
  const awaitBeforeDeadline = (pending, signal, cleanup = () => {}) => {
    if (signal.aborted) {
      try {
        cleanup();
      } catch {
        // A best-effort abort must not delay the deadline result.
      }
      return Promise.reject(new AiradioHttpError("timeout", "the station stopped answering within the adapter's deadline"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        fn(value);
      };
      const onAbort = () => {
        try {
          cleanup();
        } catch {
          // The request has already crossed its deadline; cleanup cannot extend it.
        }
        finish(reject, new AiradioHttpError("timeout", "the station stopped answering within the adapter's deadline"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(pending).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  };

  /** Read at most `maxResponseBytes`, then refuse rather than keep reading. */
  async function readBounded(response, signal) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      throw new AiradioHttpError("response-too-large", "the station's answer is larger than the adapter's bound");
    }
    if (response.body === null || response.body === undefined) {
      const text = await awaitBeforeDeadline(response.text(), signal, () => {
        try {
          void response.body?.cancel?.();
        } catch {
          // The body may already have been consumed or refused.
        }
      });
      if (encoder.encode(text).length > maxResponseBytes) {
        throw new AiradioHttpError("response-too-large", "the station's answer is larger than the adapter's bound");
      }
      return text;
    }
    const reader = response.body.getReader();
    const cancelReader = () => {
      try {
        // Cancellation is deliberately not awaited: a malicious peer can also
        // stall cancellation, but it must never hold the caller past deadline.
        void Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // The reader is already finished or already released.
      }
    };
    const chunks = [];
    let total = 0;
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await awaitBeforeDeadline(reader.read(), signal, cancelReader);
        if (done) {
          completed = true;
          break;
        }
        total += value.byteLength;
        if (total > maxResponseBytes) {
          throw new AiradioHttpError("response-too-large", "the station's answer is larger than the adapter's bound");
        }
        chunks.push(value);
      }
    } finally {
      if (!completed) cancelReader();
      try {
        reader.releaseLock();
      } catch {
        // A pending cancellation can retain the lock until the stream settles.
      }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  /**
   * One request. Every caller goes through here, so the deadline, the redirect
   * refusal, the body bound and the error mapping cannot be forgotten at a
   * call site.
   */
  async function request(path, { method = "GET", wave = null, body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {};
    if (wave !== null) headers["X-Wave"] = wave;
    if (body !== null) headers["content-type"] = "application/json";

    try {
      const response = await awaitBeforeDeadline(
        Promise.resolve().then(() => fetchImpl(`${base}${path}`, {
          method,
          headers,
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        })),
        controller.signal,
      );
      const text = await readBounded(response, controller.signal);

      if (!response.ok) {
        // The status, never the body: a remote body is attacker-influenced text
        // and may echo a credential the adapter just presented.
        throw new AiradioHttpError("http-status", `the station refused the request (HTTP ${response.status})`, { status: response.status });
      }

      const contentType = String(response.headers.get("content-type") ?? "");
      if (!/^application\/json\b/u.test(contentType)) {
        throw new AiradioHttpError("bad-content-type", "the station answered with something that is not JSON");
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new AiradioHttpError("bad-response", "the station's answer is not valid JSON");
      }
    } catch (error) {
      if (error instanceof AiradioHttpError) throw error;
      if (error && (error.name === "AbortError" || controller.signal.aborted)) {
        throw new AiradioHttpError("timeout", "the station did not answer within the adapter's deadline");
      }
      // A redirect refusal, a DNS failure and a reset all arrive here. The
      // cause is deliberately NOT forwarded: it can carry the URL, and a URL
      // can carry whatever a misconfigured station put in it.
      throw new AiradioHttpError("network", "the station could not be reached");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    origin: base,
    maxResponseBytes,
    timeoutMs,

    async health() {
      const body = await request("/health");
      if (body === null || typeof body !== "object" || body.ok !== true) {
        throw new AiradioHttpError("bad-response", "the station's health answer is not in protocol shape");
      }
      return {
        ok: true,
        service: typeof body.service === "string" ? body.service : "",
        at: typeof body.at === "string" ? body.at : "",
      };
    },

    async presence(callsign) {
      requireCallsign(callsign);
      const body = await request(`/v1/station/${callsign}`);
      if (body === null || typeof body !== "object" || typeof body.registered !== "boolean") {
        throw new AiradioHttpError("bad-response", "the station's presence answer is not in protocol shape");
      }
      return {
        registered: body.registered,
        onAir: body.onAir === true,
        lastSeen: typeof body.lastSeen === "string" ? body.lastSeen : null,
      };
    },

    async registerStation(callsign) {
      requireCallsign(callsign);
      const body = await request("/v1/station", { method: "POST", body: { callsign } });
      if (body === null || typeof body !== "object" || typeof body.callsign !== "string" || typeof body.key !== "string" || !WAVE_SHAPE.test(body.key)) {
        throw new AiradioHttpError("bad-response", "the station did not answer a registration in protocol shape");
      }
      return { callsign: body.callsign, key: body.key };
    },

    async createChannel() {
      const body = await request("/v1/channel", { method: "POST", body: {} });
      if (body === null || typeof body !== "object" || typeof body.frequency !== "string" || !FREQUENCY_SHAPE.test(body.frequency)) {
        throw new AiradioHttpError("bad-response", "the station did not answer a creation in protocol shape");
      }
      if (typeof body.wave !== "string" || !WAVE_SHAPE.test(body.wave)) {
        throw new AiradioHttpError("bad-response", "the station created a channel without handing back its wave");
      }
      return { channelId: body.frequency, wave: body.wave };
    },

    async callStation({ callsign, from, text }) {
      requireCallsign(callsign);
      requireCallsign(from);
      if (typeof text !== "string" || text === "") {
        throw new AiradioHttpError("bad-text", "a call needs a non-empty text");
      }
      if (encoder.encode(text).length > MAX_TEXT_BYTES) {
        throw new AiradioHttpError("text-too-large", "the call envelope exceeds the station's 16 KiB rule");
      }
      const body = await request(`/v1/station/${callsign}/call`, { method: "POST", body: { from, text } });
      if (body === null || typeof body !== "object" || !Number.isSafeInteger(body.seq)) {
        throw new AiradioHttpError("bad-response", "the station did not confirm the call in protocol shape");
      }
      return { sequence: body.seq };
    },

    async readMailbox({ callsign, key, since = 0, limit = undefined }) {
      requireCallsign(callsign);
      requireWave(key);
      const cursor = requireSince(since);
      const query = limit === undefined ? `?since=${cursor}` : `?since=${cursor}&limit=${limit}`;
      const body = await request(`/v1/station/${callsign}/calls${query}`, { wave: key });
      return normalizePage(body, limit);
    },

    async sendChannel({ channelId, wave, from, text }) {
      requireChannelId(channelId);
      requireWave(wave);
      requireCallsign(from);
      if (typeof text !== "string" || text === "") {
        throw new AiradioHttpError("bad-text", "a message needs a non-empty text");
      }
      if (encoder.encode(text).length > MAX_TEXT_BYTES) {
        throw new AiradioHttpError("text-too-large", "the message exceeds the station's 16 KiB rule");
      }
      // One attempt, never a retry: the relay has no idempotency key, so a
      // retry after an ambiguous failure would duplicate the message on air.
      const body = await request(`/v1/channel/${channelId}/send`, { method: "POST", wave, body: { from, text } });
      if (body === null || typeof body !== "object" || !Number.isSafeInteger(body.seq)) {
        throw new AiradioHttpError("bad-response", "the station did not confirm the send in protocol shape");
      }
      return { sequence: body.seq };
    },

    async readChannel({ channelId, wave, since = 0, limit = undefined }) {
      requireChannelId(channelId);
      requireWave(wave);
      const cursor = requireSince(since);
      const query = limit === undefined ? `?since=${cursor}` : `?since=${cursor}&limit=${limit}`;
      const body = await request(`/v1/channel/${channelId}/messages${query}`, { wave });
      return normalizePage(body, limit);
    },
  };
}

export const AIRADIO_MAX_TEXT_BYTES = MAX_TEXT_BYTES;
export const AIRADIO_DEFAULT_ORIGIN = "https://airadio.akbrd.com";
