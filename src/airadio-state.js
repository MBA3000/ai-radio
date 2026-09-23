/**
 * Origin-scoped local storage for station keys and channel waves.
 *
 * Authentication records store digests, but invitation mailboxes transport raw
 * channel capabilities. The relay is not end-to-end encrypted and offers no
 * credential-recovery API. Preserve this state independently of ordinary brain
 * backups; the daemon's historical .kofe path is not a safe backup policy.
 *
 * The operator supplies a private path outside the checkout and .kofe. Writes
 * are atomic and mode 0600. Loose, linked, malformed, and unsupported state is
 * refused rather than silently reset. Each save re-reads and merges its origin
 * bucket. Locks carry a pid and ownership token; only demonstrably dead owners
 * are reclaimed, while ambiguous locks are preserved for operator inspection.
 * close() releases only the lock this instance acquired. Credentials for a
 * different origin are never selected for network requests.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const STATE_VERSION = 1;
const CALLSIGN_SHAPE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u;
const CHANNEL_SHAPE = /^fm-[a-f0-9]{8,64}$/u;
const CREDENTIAL_SHAPE = /^[a-f0-9]{16,128}$/u;

export class AiradioStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AiradioStateError";
    this.code = code;
  }
}

/** The empty document, so a fresh store and a restored one have one shape. */
const emptyDocument = () => ({ version: STATE_VERSION, origins: {} });

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const invalidDocument = () => new AiradioStateError(
  "unreadable-state",
  "the state file does not contain a valid Airadio state document",
);

const invalidWriteValue = () => new AiradioStateError(
  "unwritable-state",
  "the value cannot be stored in the Airadio state document",
);

function isCredential(value) {
  return typeof value === "string" && CREDENTIAL_SHAPE.test(value);
}

function validateBucket(bucket) {
  if (!isRecord(bucket) || !hasOwn(bucket, "station") || !hasOwn(bucket, "key") || !hasOwn(bucket, "channels")) {
    throw invalidDocument();
  }

  if (bucket.station !== null) {
    if (!isRecord(bucket.station) || typeof bucket.station.callsign !== "string" || !CALLSIGN_SHAPE.test(bucket.station.callsign)) {
      throw invalidDocument();
    }
    if (hasOwn(bucket.station, "registeredAt") && typeof bucket.station.registeredAt !== "string") {
      throw invalidDocument();
    }
  }

  if (bucket.key !== null && !isCredential(bucket.key)) throw invalidDocument();
  if ((bucket.station === null) !== (bucket.key === null)) throw invalidDocument();
  if (!isRecord(bucket.channels)) throw invalidDocument();
  for (const [channelId, entry] of Object.entries(bucket.channels)) {
    if (!CHANNEL_SHAPE.test(channelId) || !isRecord(entry) || !isCredential(entry.wave)) {
      throw invalidDocument();
    }
    if (hasOwn(entry, "savedAt") && typeof entry.savedAt !== "string") throw invalidDocument();
  }
}

function validateDocument(document) {
  if (!isRecord(document) || document.version !== STATE_VERSION || !isRecord(document.origins)) {
    throw invalidDocument();
  }
  for (const [origin, bucket] of Object.entries(document.origins)) {
    if (origin.trim() === "") throw invalidDocument();
    validateBucket(bucket);
  }
  return document;
}

function requireCallsign(callsign) {
  if (typeof callsign !== "string" || !CALLSIGN_SHAPE.test(callsign)) throw invalidWriteValue();
}

function requireChannelId(channelId) {
  if (typeof channelId !== "string" || !CHANNEL_SHAPE.test(channelId)) throw invalidWriteValue();
}

function requireCredential(value) {
  if (!isCredential(value)) throw invalidWriteValue();
}

/**
 * A file is safe to hold secrets in when it is a regular file, has exactly one
 * name, and no bit outside the owner's is set. Anything else fails closed: the
 * adapter refuses to start rather than write a key somewhere a second reader
 * can already see it.
 */
function assertSafeFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw new AiradioStateError("unsafe-state-file", "the state file could not be inspected");
  }
  if (stat.isSymbolicLink()) {
    throw new AiradioStateError("unsafe-state-file", "the state file is a symbolic link and could point anywhere");
  }
  if (!stat.isFile()) {
    throw new AiradioStateError("unsafe-state-file", "the state path is not a regular file");
  }
  if (stat.nlink > 1) {
    throw new AiradioStateError("unsafe-state-file", "the state file has more than one name; another link is another reader");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AiradioStateError("unsafe-state-file", "the state file is readable beyond its owner");
  }
}

/** Return live, dead, or indeterminate for a pid; only ESRCH is proof of death. */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    if (error && error.code === "ESRCH") return false;
    return null;
  }
}

function sameLockFile(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sameLockRecord(left, right) {
  return left.pid === right.pid
    && left.at === right.at
    && (left.token ?? null) === (right.token ?? null);
}

/** Read a lock conservatively: anything not fully recognizable is indeterminate. */
function inspectLock(lockPath) {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    return { indeterminate: true };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || (stat.mode & 0o077) !== 0) {
    return { indeterminate: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return { indeterminate: true };
  }
  if (!isRecord(parsed)
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.at !== "string"
    || parsed.at.trim() === ""
    || (hasOwn(parsed, "token") && (typeof parsed.token !== "string" || parsed.token === ""))) {
    return { indeterminate: true };
  }
  return { stat, record: parsed };
}

function lockError() {
  return new AiradioStateError("locked", "another Airadio adapter already holds this state file");
}

/**
 * Take the single-writer lock. An empty or malformed lock is indeterminate,
 * never stale: another process may be between O_EXCL and publishing its pid.
 */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    let fd;
    try {
      fd = openSync(lockPath, "wx", FILE_MODE);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw new AiradioStateError("locked", "the state lock could not be taken");
      }
    }

    if (fd !== undefined) {
      const record = { pid: process.pid, at: new Date().toISOString(), token };
      try {
        writeSync(fd, JSON.stringify(record));
        closeSync(fd);
      } catch {
        try {
          closeSync(fd);
        } catch {
          // The lock remains indeterminate rather than risking another unlink.
        }
        throw new AiradioStateError("locked", "the state lock could not be taken");
      }
      const owned = inspectLock(lockPath);
      if (owned === null || owned.indeterminate || !sameLockRecord(owned.record, record)) {
        throw new AiradioStateError("locked", "the state lock could not be taken");
      }
      return { ...owned.stat, token };
    }

    const observed = inspectLock(lockPath);
    if (observed === null) continue;
    if (observed.indeterminate || processIsAlive(observed.record.pid) !== false) throw lockError();

    // Recheck both inode and record before reclaiming. If a stale lock was
    // replaced while it was being inspected, never unlink the replacement.
    const current = inspectLock(lockPath);
    if (current === null) continue;
    if (current.indeterminate
      || !sameLockFile(observed.stat, current.stat)
      || !sameLockRecord(observed.record, current.record)) {
      throw lockError();
    }
    try {
      unlinkSync(lockPath);
    } catch {
      throw new AiradioStateError("locked", "a stale state lock could not be cleared");
    }
  }
  throw new AiradioStateError("locked", "the state lock could not be taken");
}

function releaseLock(lockPath, owner) {
  if (owner === null) return;
  const current = inspectLock(lockPath);
  if (current === null || current.indeterminate || !sameLockFile(owner, current.stat) || current.record.token !== owner.token) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // A concurrent release already achieved the desired state.
  }
}

function readDocument(path) {
  if (!existsSync(path)) return emptyDocument();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new AiradioStateError("unreadable-state", "the state file could not be read");
  }
  if (raw.trim() === "") throw invalidDocument();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidDocument();
  }
  return validateDocument(parsed);
}

/** Write the whole document atomically at 0600 and leave no temp file behind. */
function writeDocument(path, document) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 1)}\n`, { mode: FILE_MODE, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The rename already failed; the temp file is the lesser problem.
    }
    if (error instanceof AiradioStateError) throw error;
    throw new AiradioStateError("unwritable-state", "the state file could not be written");
  }
}

const emptyBucket = () => ({ station: null, key: null, channels: {} });

/**
 * Open the private store for one origin.
 *
 * @param {{ path: string, origin: string }} options
 */
export function openAiradioState({ path, origin }) {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
    throw new AiradioStateError("state-path", "the state file must be named by an absolute path");
  }
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new AiradioStateError("state-path", "a state store must be bound to an origin");
  }

  const directory = dirname(path);
  if (!existsSync(directory)) {
    try {
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    } catch {
      throw new AiradioStateError("unwritable-state", "the state directory could not be created");
    }
  }

  assertSafeFile(path);
  const lockPath = `${path}.lock`;
  const lockOwner = acquireLock(lockPath);

  let document;
  try {
    document = readDocument(path);
  } catch (error) {
    releaseLock(lockPath, lockOwner);
    throw error;
  }

  let open = true;
  const bucketOf = (doc) => {
    if (!hasOwn(doc.origins, origin)) return emptyBucket();
    return doc.origins[origin];
  };

  let bucket = bucketOf(document);

  const requireOpen = () => {
    if (!open) throw new AiradioStateError("closed", "the state store is closed");
  };

  /**
   * Re-read, apply, write. The re-read is the point: another adapter run (or a
   * restore) may have added a row since this process loaded its snapshot, and
   * writing a stale snapshot would erase the only copy of that row's secret.
   */
  const mutate = (apply) => {
    requireOpen();
    assertSafeFile(path);
    const fresh = readDocument(path);
    const current = bucketOf(fresh);
    const next = apply(current);
    validateBucket(next);
    fresh.origins = { ...fresh.origins, [origin]: next };
    validateDocument(fresh);
    writeDocument(path, fresh);
    document = fresh;
    bucket = next;
  };

  return {
    /** The public identity registered at this origin, or null. */
    station() {
      requireOpen();
      if (!bucket.station || typeof bucket.station.callsign !== "string") return null;
      return { callsign: bucket.station.callsign, origin };
    },

    /** The private station key. Never returned to a tool caller. */
    stationKey() {
      requireOpen();
      return typeof bucket.key === "string" ? bucket.key : null;
    },

    /** Public frequencies this adapter holds a wave for. */
    channels() {
      requireOpen();
      return Object.keys(bucket.channels).sort();
    },

    /** The private wave for one frequency. Never returned to a tool caller. */
    channelWave(channelId) {
      requireOpen();
      const entry = bucket.channels[channelId];
      if (!entry || typeof entry !== "object") return null;
      return typeof entry.wave === "string" ? entry.wave : null;
    },

    /**
     * Every secret this adapter knows, for redaction. A value that can never be
     * printed must still be recognisable when a REMOTE peer reflects it back.
     */
    secrets() {
      requireOpen();
      const found = [];
      if (typeof bucket.key === "string") found.push(bucket.key);
      for (const entry of Object.values(bucket.channels)) {
        if (entry && typeof entry.wave === "string") found.push(entry.wave);
      }
      return found;
    },

    saveStation(callsign, key) {
      requireOpen();
      requireCallsign(callsign);
      requireCredential(key);
      mutate((current) => {
        if (current.station && typeof current.station.callsign === "string" && current.station.callsign !== callsign) {
          throw new AiradioStateError(
            "identity-conflict",
            "this state file already holds a different registered callsign; use a separate state file",
          );
        }
        return {
          ...current,
          station: { callsign, registeredAt: new Date().toISOString() },
          key,
        };
      });
    },

    saveChannel(channelId, wave, meta = {}) {
      requireOpen();
      requireChannelId(channelId);
      requireCredential(wave);
      mutate((current) => ({
        ...current,
        channels: {
          ...current.channels,
          [channelId]: { wave, ...meta, savedAt: new Date().toISOString() },
        },
      }));
    },

    close() {
      if (!open) return;
      open = false;
      releaseLock(lockPath, lockOwner);
    },
  };
}

/** The default private location when the operator names none. */
export function defaultAiradioStatePath(env = process.env, home = process.env.HOME ?? "") {
  const explicit = typeof env.AIRADIO_STATE === "string" && env.AIRADIO_STATE.trim() !== "" ? env.AIRADIO_STATE.trim() : null;
  if (explicit !== null) return explicit;
  const xdg = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME.trim() : null;
  const base = xdg !== null ? xdg : join(home, ".local", "state");
  return join(base, "airadio", "adapter-state.json");
}
