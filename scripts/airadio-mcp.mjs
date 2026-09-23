#!/usr/bin/env node
/**
 * THE AIRADIO MCP ADAPTER'S ENTRY POINT — a local stdio JSON-RPC server.
 *
 * This file owns the world: argv, stdin, stdout, stderr, the network client and
 * the private credential file. `src/airadio-mcp.js` owns meaning, and
 * nothing here decides what a message means.
 *
 *   node scripts/airadio-mcp.mjs --state-file /absolute/path/state.json
 *                                [--url https://airadio.akbrd.com]
 *                                [--allow-local-http] [--timeout-ms 10000]
 *
 * TRANSPORT RULES, from the MCP stdio specification and not negotiable:
 *   - stdout carries ONLY newline-delimited JSON-RPC frames. Every diagnostic
 *     goes to stderr, redacted and bounded. A single stray banner byte on
 *     stdout desynchronizes the client's parser for the rest of the session.
 *   - stdin closing is shutdown: stop accepting new calls, let the in-flight
 *     ones finish within a bounded drain, then exit.
 *
 * THE BASE URL IS A LAUNCH-TIME DECISION. It is read here, from a flag or the
 * environment, and never from a tool argument — so no model and no message can
 * point the adapter at another host. `--allow-local-http` exists for local
 * tests against a loopback emulator and permits loopback hosts only.
 */

import { createAiradioClient, AIRADIO_DEFAULT_ORIGIN } from "../src/airadio-client.js";
import { createAiradioMcpServer, createFrameDecoder, encodeMessage, redactSecrets } from "../src/airadio-mcp.js";
import { defaultAiradioStatePath, openAiradioState } from "../src/airadio-state.js";

const DRAIN_MS = 2_000;

/** Parse the operator's flags. Unknown flags fail closed rather than surprise. */
export function parseAdapterArguments(argv, env = {}) {
  const options = {
    url: null,
    stateFile: null,
    allowLocalHttp: false,
    timeoutMs: 10_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--url") options.url = takeValue();
    else if (arg === "--state-file") options.stateFile = takeValue();
    else if (arg === "--allow-local-http") options.allowLocalHttp = true;
    else if (arg === "--timeout-ms") {
      const value = Number(takeValue());
      if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) throw new Error("--timeout-ms must be 100..120000");
      options.timeoutMs = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (options.url === null) {
    const fromEnv = typeof env.AIRADIO_URL === "string" && env.AIRADIO_URL.trim() !== "" ? env.AIRADIO_URL.trim() : null;
    options.url = fromEnv ?? AIRADIO_DEFAULT_ORIGIN;
  }
  if (options.stateFile === null) options.stateFile = defaultAiradioStatePath(env, env.HOME ?? "");
  return options;
}

async function main() {
  let options;
  try {
    options = parseAdapterArguments(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`airadio-mcp: ${error.message}\n`);
    process.exit(2);
  }

  let state;
  let client;
  try {
    client = createAiradioClient({
      origin: options.url,
      timeoutMs: options.timeoutMs,
      allowLocalHttp: options.allowLocalHttp,
    });
    state = openAiradioState({ path: options.stateFile, origin: client.origin });
  } catch (error) {
    // The state path may be in the message; the operator started us with it,
    // so printing it back to the operator's own stderr is not a disclosure.
    process.stderr.write(`airadio-mcp: ${error.message}\n`);
    process.exit(2);
  }

  const server = createAiradioMcpServer({
    client,
    state,
    log: (line) => process.stderr.write(`airadio-mcp: ${String(line).slice(0, 500)}\n`),
  });

  const decoder = createFrameDecoder();
  const write = (message) => {
    try {
      process.stdout.write(encodeMessage(message));
    } catch {
      // A frame that cannot be encoded must not take the session with it.
      process.stderr.write("airadio-mcp: a reply could not be encoded\n");
    }
  };

  process.stdin.on("data", (chunk) => {
    const { frames, errors } = decoder.push(chunk);
    for (const failure of errors) {
      write({ jsonrpc: "2.0", id: null, error: { code: failure.code, message: failure.message } });
    }
    for (const frame of frames) {
      Promise.resolve(server.handle(frame))
        .then((outcome) => {
          if (outcome && outcome.kind === "reply") write(outcome.message);
        })
        .catch((error) => {
          const reason = redactSecrets(String(error && error.message ? error.message : error).slice(0, 200), state.secrets());
          process.stderr.write(`airadio-mcp: unhandled ${reason}\n`);
        });
    }
  });

  const finish = async () => {
    server.shutdown();
    const deadline = Date.now() + DRAIN_MS;
    while (server.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      state.close();
    } catch {
      // Releasing a lock we may already have lost cannot change the exit.
    }
    process.exit(0);
  };

  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, finish);
}

await main();
