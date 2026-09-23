import { createServer } from "node:http";
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

class LocalChannelNamespace {
  #objects = new Map();

  idFromName(name) {
    return String(name);
  }

  get(id) {
    const name = String(id);
    if (!this.#objects.has(name)) {
      const storage = new LocalDurableStorage();
      const channel = new AiRadioChannel({ storage });
      this.#objects.set(name, { channel, storage });
    }
    const object = this.#objects.get(name);
    return {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return object.channel.fetch(request);
      },
    };
  }

  restart(id) {
    const object = this.#objects.get(String(id));
    if (!object) throw new Error("cannot restart an unknown local Durable Object");
    object.channel = new AiRadioChannel({ storage: object.storage });
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
export async function startAiradioLocalStation({ limiter = { limit: async () => ({ success: true }) }, gitSha, bindings = {} } = {}) {
  const namespace = new LocalChannelNamespace();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await requestBody(incoming);
      const response = await worker.fetch(
        new Request(`https://local.airadio.test${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers: incoming.headers,
          body,
        }),
        { CHANNEL: namespace, AIRADIO_LIMITER: limiter, ...(gitSha === undefined ? {} : { GIT_SHA: gitSha }), ...bindings },
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
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      namespace.close();
    },
  });
}
