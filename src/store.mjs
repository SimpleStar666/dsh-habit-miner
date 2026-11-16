/**
 * Persistence for the habit miner.
 *
 * Design constraints, each one from a concrete failure mode:
 *
 * 1. **Zero native dependencies.** Plain JSON / JSONL under one directory, so the
 *    plugin installs anywhere with no build step and no `allowBuilds` approval.
 * 2. **Atomic writes.** Every file is written to a temp file in the same directory
 *    and renamed over the target; Windows can briefly lock the target, so the
 *    rename retries a few times.
 * 3. **Signals are append-only.** What the plugin observed is never rewritten;
 *    candidates are the derived layer and may be recomputed.
 * 4. **Snapshots before touching AGENTS.md.** Every write to a rule file keeps the
 *    previous content next to the store, so a bad write is one click away from
 *    being undone.
 *
 * @module dsh-habit-miner/store
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** How many signal lines to keep in the log. */
export const MAX_SIGNALS = 4000;

/** How many snapshots to keep. */
export const MAX_SNAPSHOTS = 40;

/**
 * Resolve the store directory tree.
 *
 * @param {{storeDir?: string, homeDir?: string}} [config]
 * @returns {{dir: string, signals: string, candidates: string, reviews: string, applied: string, config: string, state: string, scanState: string, snapshots: string}}
 */
export function resolvePaths(config = {}) {
  const home = config.homeDir
    || process.env.DSH_HOME
    || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const dir = config.storeDir && String(config.storeDir).trim()
    ? String(config.storeDir).trim()
    : join(home, 'habit-miner');
  return {
    dir,
    signals: join(dir, 'signals.jsonl'),
    candidates: join(dir, 'candidates.json'),
    reviews: join(dir, 'reviews.jsonl'),
    applied: join(dir, 'applied.json'),
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    scanState: join(dir, 'scan-state.json'),
    snapshots: join(dir, 'snapshots'),
  };
}

/**
 * Create the store directory tree if missing.
 *
 * @param {ReturnType<typeof resolvePaths>} paths
 * @returns {void}
 */
export function ensureStore(paths) {
  for (const dir of [paths.dir, paths.snapshots]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Block for a few milliseconds inside the atomic-write retry loop. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy wait */ }
  }
}

/** Windows failure codes for "briefly locked", safe to retry. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

/**
 * Write a file atomically.
 *
 * @param {string} path target path
 * @param {string} content file content
 * @param {{attempts?: number}} [options]
 * @returns {void}
 */
export function atomicWrite(path, content, options = {}) {
  const attempts = Math.max(1, Math.min(10, options.attempts ?? 5));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, content, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME.has(error?.code)) break;
      sleepSync(4 + attempt * 4);
    }
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }
  throw lastError;
}

/**
 * Read a JSON file, returning a fallback instead of throwing.
 *
 * @param {string} path
 * @param {any} fallback
 * @returns {any}
 */
export function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file atomically.
 *
 * @param {string} path
 * @param {any} value
 * @returns {void}
 */
export function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Append one record to a JSONL file.
 *
 * @param {string} path
 * @param {any} record
 * @returns {void}
 */
export function appendJsonl(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Read a JSONL file defensively: a torn last line is skipped, not fatal.
 *
 * @param {string} path
 * @param {number} [max] keep only the last N records
 * @returns {any[]}
 */
export function readJsonl(path, max = Number.POSITIVE_INFINITY) {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n');
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch { /* torn line from a crash: skip it */ }
    }
    return Number.isFinite(max) ? out.slice(-max) : out;
  } catch {
    return [];
  }
}

/**
 * Trim a JSONL file to its last N lines (called rarely, after an append).
 *
 * @param {string} path
 * @param {number} max
 * @returns {void}
 */
export function trimJsonl(path, max) {
  const records = readJsonl(path);
  if (records.length <= max) return;
  const kept = records.slice(-max);
  atomicWrite(path, kept.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

/**
 * Load the candidate list.
 *
 * @param {ReturnType<typeof resolvePaths>} paths
 * @returns {any[]}
 */
export function loadCandidates(paths) {
  const value = readJson(paths.candidates, []);
  return Array.isArray(value) ? value : [];
}

/**
 * Persist the candidate list.
 *
 * @param {ReturnType<typeof resolvePaths>} paths
 * @param {any[]} candidates
 * @returns {void}
 */
export function saveCandidates(paths, candidates) {
  writeJson(paths.candidates, candidates);
}

/**
 * Load the applied-rule ledger.
 *
 * @param {ReturnType<typeof resolvePaths>} paths
 * @returns {{rules: any[], lastWrite: any}}
 */
export function loadApplied(paths) {
  const value = readJson(paths.applied, { rules: [], lastWrite: null });
  return {
    rules: Array.isArray(value?.rules) ? value.rules : [],
    lastWrite: value?.lastWrite ?? null,
  };
}

/**
 * Persist the applied-rule ledger.
 *
 * @param {ReturnType<typeof resolvePaths>} paths
 * @param {{rules: any[], lastWrite: any}} value
 * @returns {void}
 */
export function saveApplied(paths, value) {
  writeJson(paths.applied, value);
}

/**
 * Snapshot a rule file before writing it.
 *
 * @param {ReturnType<typeof resolvePaths>} paths
 * @param {{file: string, content: string, reason: string}} input
 * @returns {string} snapshot path
 */
export function snapshotFile(paths, input) {
  const at = new Date();
  const stamp = `${at.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const target = join(paths.snapshots, `${stamp}.json`);
  writeJson(target, { at: at.toISOString(), file: input.file, reason: input.reason, content: input.content });
  // Keep the directory bounded.
  try {
    const entries = readdirSync(paths.snapshots).filter((name) => name.endsWith('.json')).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - MAX_SNAPSHOTS))) {
      try { unlinkSync(join(paths.snapshots, stale)); } catch { /* ignore */ }
    }
  } catch { /* bounded housekeeping only */ }
  return target;
}

/**
 * Read a file as UTF-8 text, returning '' when it does not exist.
 *
 * @param {string} path
 * @returns {string}
 */
export function readTextFile(path) {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Size in bytes, or 0 when missing.
 *
 * @param {string} path
 * @returns {number}
 */
export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read a byte range (used to probe a file head cheaply).
 *
 * @param {string} path
 * @param {number} length
 * @returns {Buffer}
 */
export function readHead(path, length = 64) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return read < length ? buffer.subarray(0, read) : buffer;
  } finally {
    closeSync(fd);
  }
}
