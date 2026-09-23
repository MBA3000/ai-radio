/**
 * WEB PUSH for the station — what lets a phone that installed the app from
 * Safari ("Add to Home Screen") light up when someone speaks on a channel.
 *
 * Pure WebCrypto, no dependencies, so the same code runs in the Worker and in
 * node:test:
 *   - RFC 8291 message encryption (aes128gcm): only the subscribed device can
 *     read the text; the push service (Apple, Google, Mozilla) sees ciphertext.
 *   - RFC 8292 VAPID: an ES256 JWT identifies this station to the push service.
 * The station keeps its VAPID key pair in a Durable Object of its own, so there
 * is no secret to provision and staging and production never share one.
 */

const encoder = new TextEncoder();

export function b64url(bytes) {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromB64url(text) {
  const normal = String(text).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** Push services accept at most 4096 bytes of body; the header takes 86 of them. */
export const MAX_PUSH_PLAINTEXT = 3_900;
const RECORD_SIZE = 4096;

/**
 * Encrypt one push message for one subscription (RFC 8291, single record).
 * `salt` and `serverKeys` are parameters only so the RFC's own example can be
 * reproduced byte for byte in tests; normally both are fresh per message.
 */
export async function encryptPushPayload(keys, plaintext, { salt, serverKeys } = {}) {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("invalid subscription keys");
  if (plaintext.length > MAX_PUSH_PLAINTEXT) throw new Error("push payload too large");
  const recordSalt = salt || crypto.getRandomValues(new Uint8Array(16));
  const pair = serverKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(recordSalt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(recordSalt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record, so the plaintext ends with the last-record delimiter 0x02.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(recordSalt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64url(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** The Authorization header that identifies this station to a push service (RFC 8292). */
export async function vapidAuthorization({ endpoint, vapid, subject, now = Date.now() }) {
  const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(header + "." + claims)));
  return "vapid t=" + header + "." + claims + "." + b64url(signature) + ", k=" + vapid.publicKey;
}

/**
 * The station only ever posts to real push services: a subscription is data
 * from a key holder, and an arbitrary endpoint would turn the station into a
 * request relay for anyone with a channel key.
 */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/u,
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/u,
  /^fcm\.googleapis\.com$/u,
  /^updates\.push\.services\.mozilla\.com$/u,
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/u,
];

export function pushEndpointAllowed(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" || String(endpoint).length > 1024) return false;
  return PUSH_HOSTS.some((pattern) => pattern.test(url.hostname));
}

/** A browser PushSubscription.toJSON() in, a normalized record or an error out. */
export function parseSubscription(body) {
  if (!body || typeof body !== "object") return { error: "a push subscription object is required" };
  const { endpoint, keys } = body;
  if (typeof endpoint !== "string" || !pushEndpointAllowed(endpoint)) return { error: "endpoint must be an https URL of a known push service" };
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return { error: "keys.p256dh and keys.auth are required" };
  let p256dh;
  let auth;
  try {
    p256dh = fromB64url(keys.p256dh);
    auth = fromB64url(keys.auth);
  } catch {
    return { error: "keys must be base64url" };
  }
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return { error: "keys are not a P-256 public key and a 16-byte auth secret" };
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Encrypt and post one notification. Returns the push service's HTTP status. */
export async function sendWebPush(subscription, payload, { vapid, subject, fetchImpl = fetch, ttl = 86_400, urgency = "high", topic } = {}) {
  const body = await encryptPushPayload(subscription.keys, encoder.encode(JSON.stringify(payload)));
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: await vapidAuthorization({ endpoint: subscription.endpoint, vapid, subject }),
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32);
  const response = await fetchImpl(subscription.endpoint, { method: "POST", headers, body, redirect: "manual" });
  return response.status;
}
