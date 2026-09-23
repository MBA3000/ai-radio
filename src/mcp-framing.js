/**
 * MCP stdio framing primitives: newline-delimited JSON-RPC 2.0, one message per
 * line, no embedded newlines (NOT the LSP `Content-Length:` framing).
 * `JSON.stringify` escapes newlines inside strings, so one encoded message is
 * always exactly one line.
 *
 * These three helpers are all the adapter needs from a JSON-RPC layer; they
 * decide nothing about protocol versions or tools. No I/O here.
 */

/**
 * Encode one JSON-RPC message as a wire frame: exactly one line, newline
 * terminated. Throws rather than emit a frame with an embedded newline — a
 * split frame would desynchronize the client's parser for the rest of the run.
 */
export function encodeMessage(message) {
  const line = JSON.stringify(message);
  if (typeof line !== "string") throw new TypeError("message is not JSON-serializable");
  if (line.includes("\n")) throw new Error("encoded MCP frame contains a newline");
  return `${line}\n`;
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}
