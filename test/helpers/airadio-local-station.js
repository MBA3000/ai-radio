import { createHash } from "node:crypto";
import { createServer, STATUS_CODES } from "node:http";
import { DatabaseSync } from "node:sqlite";

import worker, { AiRadioChannel } from "../../worker/worker.mjs";

const EMPTY_RESULT = Object.freeze({ toArray: () => [] });
const READ_STATEMENT = /^\s*(?:select|with|pragma|explain)\b/iu;

class LocalDurableStorage {
  #database;
  #alarmAt = null;

  constructor() {
    this.#database = new DatabaseSync(":memory:");
    this.sql = Object.freeze({
      exec: (statement, ...parameters) => this.#exec(statement, parameters),
    });
  }

  #exec(statement, parameters) {
    if (parameters.length === 0) {
      if (READ_STATEMENT.test(statement)) {
        const rows = this.#database.prepare(statement).all();
        return { toArray: () => rows };
      }
      this.#database.exec(statement);
      return EMPTY_RESULT;
    }

    const query = this.#database.prepare(statement);
    if (READ_STATEMENT.test(statement)) {
      const rows = query.all(...parameters);
      return { toArray: () => rows };
    }
    query.run(...parameters);
    return EMPTY_RESULT;
  }

  async setAlarm(at) {
    this.#alarmAt = at;
  }

  async deleteAll() {
    this.#database.exec("DELETE FROM meta; DELETE FROM msgs;");
  }

  alarmAt() {
    return this.#alarmAt;
  }

  close() {
    this.#database.close();
  }
}

// A WebSocket server just big enough for the station's live delivery: the
// RFC 6455 handshake, unfragmented text frames, ping and close. It stands in
// for the Hibernation API (acceptWebSocket, getWebSockets, auto-response),
// so the channel's real code runs against real sockets.
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode, payload) {
  const data = Buffer.from(payload);
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  while (rest.length >= 2) {
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) break;
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    const maskAt = offset;
    if (masked) offset += 4;
    if (rest.length < offset + length) break;
    const payload = Buffer.from(rest.subarray(offset, offset + length));
    if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= rest[maskAt + (index % 4)];
    frames.push({ opcode, payload });
    rest = rest.subarray(offset + length);
  }
  return { frames, rest };
}

/** The channel's end of a socket, with the methods workerd gives it. */
class LocalServerSocket {
  #tcp = null;
  #queue = [];
  #attachment = null;
  #onGone;
  closed = false;
  pingedAt = null;

  constructor(onGone) {
    this.#onGone = onGone;
  }

  bind(tcp) {
    this.#tcp = tcp;
    for (const frame of this.#queue) tcp.write(frame);
    this.#queue = [];
  }

  #write(frame) {
    if (this.#tcp) this.#tcp.write(frame);
    else this.#queue.push(frame);
  }

  send(text) {
    if (this.closed) throw new Error("the socket is closed");
    this.#write(encodeFrame(0x1, String(text)));
  }

  close(code = 1000, reason = "") {
    if (this.closed) throw new Error("the socket is already closed");
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#write(encodeFrame(0x8, payload));
    this.gone();
    if (this.#tcp) this.#tcp.end();
  }

  gone() {
    if (this.closed) return;
    this.closed = true;
    this.#onGone(this);
  }

  destroy() {
    this.gone();
    if (this.#tcp) this.#tcp.destroy();
  }

  serializeAttachment(value) {
    this.#attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return structuredClone(this.#attachment);
  }
}

/** A channel object's context: storage, a clock, and the Hibernation API. */
function channelContext(storage, clock) {
  const sockets = new Set();
  let autoResponse = null;
  const context = {
    storage,
    ...(clock ? { now: clock } : {}),
    sockets,
    acceptWebSocket: (socket) => { sockets.add(socket); },
    getWebSockets: () => [...sockets],
    setWebSocketAutoResponse: (pair) => { autoResponse = pair; },
    autoResponse: () => autoResponse,
    getWebSocketAutoResponseTimestamp: (socket) => socket.pingedAt,
    webSocketPair: () => {
      const server = new LocalServerSocket((socket) => sockets.delete(socket));
      return { 0: { server }, 1: server };
    },
    upgraded: (client) => ({ status: 101, webSocket: client }),
  };
  return context;
}

// The workerd global the channel builds its auto-response with.
if (typeof globalThis.WebSocketRequestResponsePair !== "function") {
  globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
    constructor(request, response) {
      this.request = request;
      this.response = response;
    }
  };
}

class LocalChannelNamespace {
  #objects = new Map();
  #clock;

  constructor(clock) {
    this.#clock = clock;
  }

  idFromName(name) {
    return String(name);
  }

  get(id) {
    const name = String(id);
    if (!this.#objects.has(name)) {
      const storage = new LocalDurableStorage();
      const context = channelContext(storage, this.#clock);
      const channel = new AiRadioChannel(context);
      this.#objects.set(name, { channel, storage, context });
    }
    const object = this.#objects.get(name);
    return {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return object.channel.fetch(request);
      },
    };
  }

  object(id) {
    return this.#objects.get(String(id)) || null;
  }

  /** Like a deploy: every socket drops, and a fresh object takes over. */
  restart(id) {
    const object = this.#objects.get(String(id));
    if (!object) throw new Error("cannot restart an unknown local Durable Object");
    for (const socket of object.context.getWebSockets()) {
      try { socket.close(1001, "the station is restarting"); } catch {}
    }
    object.context = channelContext(object.storage, this.#clock);
    object.channel = new AiRadioChannel(object.context);
  }

  /** Like hibernation: the object is rebuilt, and its sockets stay open. */
  hibernate(id) {
    const object = this.#objects.get(String(id));
    if (!object) throw new Error("cannot hibernate an unknown local Durable Object");
    object.channel = new AiRadioChannel(object.context);
  }

  dropSockets() {
    for (const object of this.#objects.values()) {
      for (const socket of object.context.getWebSockets()) socket.destroy();
    }
  }

  close() {
    for (const object of this.#objects.values()) object.storage.close();
    this.#objects.clear();
  }
}

const requestBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
};

/**
 * Starts an isolated loopback-only HTTP facade over the production Airadio
 * Worker and AiRadioChannel. Only the DO storage/alarm boundary is emulated
 * with an in-memory node:sqlite DatabaseSync instance; no Cloudflare runtime,
 * deployed Worker, or live Airadio state participates in this helper.
 */
export async function startAiradioLocalStation({ limiter = { limit: async () => ({ success: true }) }, gitSha, bindings = {}, clock = null, webSockets = true } = {}) {
  const namespace = new LocalChannelNamespace(clock);
  const env = { CHANNEL: namespace, AIRADIO_LIMITER: limiter, ...(gitSha === undefined ? {} : { GIT_SHA: gitSha }), ...bindings };
  const reads = new Map();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const read = /^\/v1\/(?:channel\/(fm-[a-f0-9]+)\/messages|station\/([a-z0-9-]+)\/calls)/u.exec(incoming.url ?? "");
      const reader = read ? read[1] || "station:" + read[2] : null;
      if (reader) reads.set(reader, (reads.get(reader) || 0) + 1);
      const body = await requestBody(incoming);
      const response = await worker.fetch(
        new Request(`https://local.airadio.test${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers: incoming.headers,
          body,
        }),
        env,
      );
      for (const [name, value] of response.headers) outgoing.setHeader(name, value);
      outgoing.statusCode = response.status;
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json; charset=utf-8");
      outgoing.end('{"error":"local Airadio station failure"}\n');
    }
  });

  const refuse = (tcp, status, text) => {
    tcp.end("HTTP/1.1 " + status + " " + (STATUS_CODES[status] || "Error") + "\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: "
      + Buffer.byteLength(text) + "\r\nconnection: close\r\n\r\n" + text);
  };
  server.on("upgrade", async (incoming, tcp, head) => {
    tcp.on("error", () => {});
    try {
      if (!webSockets) return refuse(tcp, 404, '{"error":"unknown call — GET / for the instructions"}');
      const response = await worker.fetch(
        new Request(`https://local.airadio.test${incoming.url ?? "/"}`, { method: "GET", headers: incoming.headers }),
        env,
      );
      if (response.status !== 101 || !response.webSocket) return refuse(tcp, response.status, await response.text());
      const socket = response.webSocket.server;
      const target = /^\/v1\/(?:channel\/(fm-[a-f0-9]+)|station\/([a-z0-9-]+))\/ws/u.exec(incoming.url ?? "");
      // Channels are named by frequency, mailboxes by "station:<callsign>".
      const frequency = target ? target[1] || "station:" + target[2] : null;
      const accept = createHash("sha1").update(String(incoming.headers["sec-websocket-key"]) + WEBSOCKET_GUID).digest("base64");
      tcp.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
      socket.bind(tcp);
      let pending = Buffer.from(head || []);
      const channel = () => namespace.object(frequency);
      tcp.on("data", (chunk) => {
        const decoded = decodeFrames(Buffer.concat([pending, chunk]));
        pending = decoded.rest;
        for (const frame of decoded.frames) {
          const object = channel();
          if (frame.opcode === 0x8) {
            // The receiver closes: answer, and tell the channel as workerd would.
            if (!socket.closed) {
              socket.gone();
              tcp.end(encodeFrame(0x8, frame.payload.subarray(0, 2)));
              if (object) object.channel.webSocketClose(socket, frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005, "", true);
            }
          } else if (frame.opcode === 0x9) {
            tcp.write(encodeFrame(0xa, frame.payload));
          } else if (frame.opcode === 0x1) {
            const text = frame.payload.toString("utf8");
            const pair = object ? object.context.autoResponse() : null;
            if (pair && text === pair.request) {
              // Answered without waking the channel, as hibernation does.
              socket.pingedAt = new Date(clock ? clock() : Date.now());
              tcp.write(encodeFrame(0x1, pair.response));
            } else if (object) {
              object.channel.webSocketMessage(socket, text);
            }
          }
        }
      });
      tcp.on("close", () => {
        if (socket.closed) return;
        socket.gone();
        const object = channel();
        if (object) object.channel.webSocketClose(socket, 1006, "", false);
      });
    } catch {
      tcp.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    namespace.close();
    throw new Error("local Airadio station did not bind a loopback TCP port");
  }

  let closed = false;
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    restart: (id) => namespace.restart(id),
    hibernate: (id) => namespace.hibernate(id),
    /** How many REST receives reached a channel (or "station:<callsign>" for a mailbox): a receiver on a live socket stops polling. */
    reads: (frequency) => reads.get(frequency) || 0,
    /** The channel's open sockets. */
    sockets: (frequency) => namespace.object(frequency)?.context.getWebSockets() ?? [],
    /** Runs the channel's alarm now, as the runtime would when it is due. */
    alarm: async (frequency) => {
      const object = namespace.object(frequency);
      if (object) await object.channel.alarm();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      namespace.dropSockets();
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      namespace.close();
    },
  });
}
