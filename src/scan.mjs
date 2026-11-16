/**
 * History backfill through the Host session-query service.
 *
 * DSH's base profile mounts `session-query-sqlite` with `openAt: never`, so exact
 * reads work on every profile while the SQLite search index stays off. The service
 * exposes no cross-session event scan: the only way is "list sessions, then read
 * each". Replaying a log is not free (every call re-validates the whole log), so
 * this module is deliberately bounded:
 *
 * - a day window and a session cap from config,
 * - message events only, current surface only,
 * - one growing total-event budget that ends the pass early,
 * - every failure degrades to "no backfill", never to a broken plugin.
 *
 * @module dsh-habit-miner/scan
 */

/** Hard ceiling on message events replayed by one backfill. */
export const MAX_EVENTS_PER_SCAN = 20000;

import { classifySignal } from './text.mjs';

/** Message event types the backfill keeps. */
const MESSAGE_TYPES = ['user/message', 'assistant/message'];

/**
 * Normalise whatever the service reports as a timestamp into ISO text.
 *
 * @param {unknown} value
 * @returns {string}
 */
function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  if (typeof value === 'string' && value) return value;
  return new Date().toISOString();
}

/**
 * The cwd recorded on a session record, defensively.
 *
 * @param {any} record
 * @returns {string|null}
 */
function recordCwd(record) {
  const header = record?.header ?? {};
  const value = header.cwd ?? header.workingDirectory ?? header.projectPath;
  return typeof value === 'string' && value ? value : null;
}

/**
 * The session id recorded on a session record, defensively.
 *
 * @param {any} record
 * @returns {string|null}
 */
function isDelegated(record) {
  const header = record?.header ?? {};
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

function recordId(record) {
  const header = record?.header ?? {};
  const value = header.id ?? record?.id;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Run one bounded backfill.
 *
 * @param {object} input
 * @param {any} input.query the `sessionQuery` service
 * @param {object} input.config normalized config
 * @param {(signal: object) => void} input.onSignal called for every correction found
 * @param {(sessionId: string, cwd: string|null) => void} [input.onSession] called per replayed session
 * @param {(sessionId: string, record: any) => boolean} [input.skipSession] skip sessions already replayed
 * @param {(message: object) => void} [input.onUserMessage] every user message replayed (diagnostics)
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ok: boolean, reason?: string, sessions: number, events: number, signals: number}>}
 */
export async function scanHistory({ query, config, onSignal, onSession, skipSession, onUserMessage, signal }) {
  if (!query || typeof query.filterSessions !== 'function' || typeof query.filterEvents !== 'function') {
    return { ok: false, reason: 'no-session-query', sessions: 0, events: 0, signals: 0 };
  }

  const days = Math.max(1, Number(config?.scanDays) || 30);
  const cap = Math.max(1, Number(config?.scanMaxSessions) || 60);
  const from = Date.now() - days * 86_400_000;

  let records;
  try {
    records = await query.filterSessions([{ kind: 'created-at', from }], signal);
  } catch (error) {
    return { ok: false, reason: `filterSessions: ${error?.message ?? error}`, sessions: 0, events: 0, signals: 0 };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: true, sessions: 0, events: 0, signals: 0 };
  }

  let sessions = 0;
  let events = 0;
  let signals = 0;

  for (const record of records.slice(0, cap)) {
    if (signal?.aborted) break;
    const sessionId = recordId(record);
    if (!sessionId) continue;
    if (events >= MAX_EVENTS_PER_SCAN) break;
    if (isDelegated(record)) continue;
    try {
      if (skipSession?.(sessionId, record)) continue;
    } catch { /* a broken predicate must not end the pass */ }

    let rows;
    try {
      rows = await query.filterEvents(sessionId, [
        { kind: 'type', values: MESSAGE_TYPES },
        { kind: 'surface', values: ['current'] },
      ], signal);
    } catch {
      // One unreadable session must not end the pass.
      continue;
    }
    if (!Array.isArray(rows) || rows.length === 0) continue;
    sessions += 1;
    const cwd = recordCwd(record);
    try { onSession?.(sessionId, cwd); } catch { /* observer only */ }

    let lastAssistant = null;
    for (const row of rows) {
      if (events >= MAX_EVENTS_PER_SCAN) break;
      events += 1;
      const text = typeof row?.text === 'string' ? row.text : '';
      if (!text) continue;
      if (row.type === 'assistant/message') {
        lastAssistant = text;
        continue;
      }
      if (row.type !== 'user/message') continue;
      try {
        onUserMessage?.({ userText: text, assistantText: lastAssistant, sessionId, workspace: cwd, at: toIso(row.time) });
        // A cheap pre-check keeps the caller (and the stats) honest: only real
        // correction shapes are handed over.
        if (classifySignal(text).kind) {
          const produced = onSignal({
            userText: text,
            assistantText: lastAssistant,
            sessionId,
            workspace: cwd,
            at: toIso(row.time),
            channel: 'scan',
          });
          if (produced) signals += 1;
        }
      } catch {
        // A single malformed message must not end the pass.
      }
      lastAssistant = null;
    }
  }

  return { ok: true, sessions, events, signals };
}
