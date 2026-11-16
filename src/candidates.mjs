/**
 * Candidate clustering: from one observed correction to one reviewable habit.
 *
 * The rules of this module:
 *
 * - **Two sessions or it is not a habit.** A single correction is often about this
 *   task; the same correction appearing in a second session is a pattern. Until
 *   then the candidate stays `observing` and never reaches the queue.
 * - **Near-duplicates merge, contradictions wait for a human.** Same topic and same
 *   polarity bumps support; same topic with the opposite polarity becomes a
 *   conflict that the panel asks about instead of guessing.
 * - **Rejection is a signal.** A rejected candidate keeps suppressing that text
 *   from being re-proposed for a while, and the review ledger records it.
 *
 * @module dsh-habit-miner/candidates
 */

import { classifySignal, clip, draftRule, hasNegation, normalizeText } from './text.mjs';
import { hamming, nearDuplicate, simhash } from './similar.mjs';

/** Statuses a candidate can hold. */
export const STATUS = Object.freeze({
  observing: 'observing',
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  conflict: 'conflict',
  archived: 'archived',
});

/** How long a rejected candidate suppresses the same text from being re-proposed. */
export const REJECT_SUPPRESS_DAYS = 30;

/** Maximum evidence entries kept per candidate. */
const MAX_EVIDENCE = 5;

/** Maximum excerpt length stored per evidence entry. */
const MAX_EXCERPT = 220;

/**
 * Build an id that is stable per draft text and unique enough per store.
 *
 * @param {string} draft rule draft
 * @param {number} [salt]
 * @returns {string}
 */
export function candidateId(draft, salt = 0) {
  const hash = simhash(`${draft}|${salt}`);
  return `hab-${(hash || '0000000000000000').slice(0, 8)}`;
}

/**
 * Turn a raw observation into a signal record.
 *
 * @param {object} input
 * @param {string} input.userText the user's message
 * @param {string} [input.assistantText] the assistant message the user is reacting to
 * @param {string} [input.sessionId]
 * @param {string} [input.workspace] absolute cwd of the session
 * @param {string} [input.at] ISO timestamp
 * @param {string} [input.channel] `live` or `scan`
 * @returns {object|null} the signal, or null when the message is not a correction
 */
export function makeSignal(input) {
  const userText = String(input?.userText ?? '').trim();
  const classification = classifySignal(userText);
  if (!classification.kind) return null;
  const draft = draftRule(userText);
  if (!draft) return null;
  const at = input?.at || new Date().toISOString();
  return {
    id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    sessionId: input?.sessionId ? String(input.sessionId) : null,
    workspace: input?.workspace ? String(input.workspace) : null,
    userText: clip(userText, 600),
    assistantExcerpt: input?.assistantText ? clip(input.assistantText, MAX_EXCERPT) : null,
    draft,
    kind: classification.kind,
    marker: classification.marker,
    norm: normalizeText(draft),
    hash: simhash(draft),
    channel: input?.channel || 'live',
  };
}

/**
 * Compute a confidence value from evidence counts.
 *
 * Deliberately conservative: it starts below certainty, grows with distinct
 * sessions (the strong signal) and total occurrences, and is capped so the panel
 * never implies more than "probably".
 *
 * @param {{support: number, sessions: number, kind?: string, conflict?: boolean}} input
 * @returns {number} 0..0.95
 */
export function confidenceOf({ support, sessions, kind, conflict }) {
  const total = 0.3
    + 0.16 * Math.max(0, (sessions || 0) - 1)
    + 0.08 * Math.max(0, (support || 0) - 1)
    + (kind === 'rule' ? 0.08 : 0);
  const capped = Math.min(0.95, total);
  return conflict ? Math.min(capped, 0.5) : Math.round(capped * 100) / 100;
}

/**
 * Find the candidate that describes the same habit as `signal`.
 *
 * Rejected and archived candidates still take part, so a text the user dismissed
 * is not queued again the next day.
 *
 * @param {any[]} candidates
 * @param {object} signal
 * @returns {any|null}
 */
export function findMatch(candidates, signal) {
  let best = null;
  let bestDistance = 65;
  for (const candidate of candidates) {
    if (!candidate || !candidate.draft) continue;
    if (!nearDuplicate(candidate.draft, signal.draft)) continue;
    const distance = hamming(candidate.hash || '', signal.hash || '');
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Append an evidence entry, keeping the list bounded and ordered oldest-first.
 *
 * @param {any[]} evidence
 * @param {object} signal
 * @returns {any[]}
 */
function withEvidence(evidence, signal) {
  const entry = {
    userText: signal.userText,
    draft: signal.draft,
    at: signal.at,
    sessionId: signal.sessionId,
    workspace: signal.workspace,
    assistantExcerpt: signal.assistantExcerpt,
    channel: signal.channel,
    kind: signal.kind,
  };
  const list = Array.isArray(evidence) ? [...evidence, entry] : [entry];
  return list.slice(-MAX_EVIDENCE);
}

/**
 * Merge one signal into the candidate set.
 *
 * @param {any[]} candidates current candidates (mutated copy returned)
 * @param {any[]} appliedRules accepted rules that already live in a rule file
 * @param {object} signal output of {@link makeSignal}
 * @param {object} config normalized config
 * @returns {{candidates: any[], candidate: any|null, result: 'new'|'merged'|'duplicate'|'suppressed'|'ignored'}}
 */
export function ingestSignal(candidates, appliedRules, signal, config) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!signal) return { candidates: list, candidate: null, result: 'ignored' };

  // An accepted rule already covers this: bump its evidence instead of proposing again.
  for (const rule of appliedRules || []) {
    if (!rule?.text) continue;
    if (!nearDuplicate(rule.text, signal.draft)) continue;
    const samePolarity = hasNegation(rule.text) === hasNegation(signal.draft);
    if (samePolarity) {
      rule.support = (rule.support || 1) + 1;
      rule.lastSeenAt = signal.at;
      rule.sessions = Array.from(new Set([...(rule.sessions || []), signal.sessionId].filter(Boolean)));
      return { candidates: list, candidate: null, result: 'duplicate' };
    }
  }

  const now = new Date().toISOString();
  const match = findMatch(list, signal);

  if (match) {
    // A dismissed candidate stays dismissed until the suppression window passes.
    if (match.status === STATUS.rejected && Date.now() - Date.parse(match.updatedAt || match.createdAt) < REJECT_SUPPRESS_DAYS * 86_400_000) {
      return { candidates: list, candidate: match, result: 'suppressed' };
    }
    match.evidence = withEvidence(match.evidence, signal);
    match.support = (match.support || 0) + 1;
    const sessions = new Set([...(match.sessions || []), signal.sessionId].filter(Boolean));
    const workspaceSet = new Set((match.evidence || []).map((entry) => entry.workspace).filter(Boolean));
    match.sessions = [...sessions];
    match.lastSeenAt = signal.at;
    match.updatedAt = now;
    const polarityDiffers = hasNegation(match.draft) !== hasNegation(signal.draft);
    if (polarityDiffers) {
      match.conflict = true;
    }
    if (match.status === STATUS.rejected) match.status = STATUS.observing;
    // Prefer the clearer draft when the new one is a strict improvement.
    if (signal.draft.length > match.draft.length && signal.draft.length <= 120 && signal.kind === 'rule') {
      match.draft = signal.draft;
      match.norm = signal.norm;
      match.hash = signal.hash;
    }
    match.scope = match.scope || defaultScope(workspaceSet, config);
    match.workspace = match.scope === 'workspace' ? (match.workspace || [...workspaceSet][0] || null) : null;
    match.confidence = confidenceOf({
      support: match.support,
      sessions: match.sessions.length,
      kind: signal.kind,
      conflict: match.conflict,
    });
    return { candidates: list, candidate: match, result: 'merged' };
  }

  const draft = signal.draft;
  const workspaceSet = new Set([signal.workspace].filter(Boolean));
  const candidate = {
    id: candidateId(draft, list.length),
    status: STATUS.observing,
    draft,
    norm: signal.norm,
    hash: signal.hash,
    evidence: withEvidence([], signal),
    support: 1,
    sessions: [signal.sessionId].filter(Boolean),
    scope: defaultScope(workspaceSet, config),
    workspace: signal.workspace || null,
    confidence: confidenceOf({ support: 1, sessions: 1, kind: signal.kind }),
    conflict: false,
    conflictWith: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: signal.at,
  };
  list.push(candidate);
  return { candidates: list, candidate, result: 'new' };
}

/**
 * Default scope for a new habit: a habit that only appeared in one workspace stays
 * with that workspace, everything else is global.
 *
 * @param {Set<string>} workspaces
 * @param {object} config
 * @returns {'global'|'workspace'}
 */
export function defaultScope(workspaces, config) {
  if (config?.scopeDefault === 'workspace' && workspaces.size === 1) return 'workspace';
  return 'global';
}

/**
 * Promote observing candidates that crossed the evidence thresholds, and keep the
 * queue bounded.
 *
 * @param {any[]} candidates
 * @param {object} config
 * @returns {{promoted: number, demoted: number}}
 */
export function reconcileStatuses(candidates, config) {
  const list = Array.isArray(candidates) ? candidates : [];
  let promoted = 0;
  for (const candidate of list) {
    if (!candidate || candidate.status !== STATUS.observing) continue;
    const sessions = Array.isArray(candidate.sessions) ? candidate.sessions.length : 0;
    if (sessions >= config.minSessions && (candidate.support || 0) >= config.minSupport) {
      candidate.status = candidate.conflict ? STATUS.conflict : STATUS.pending;
      candidate.updatedAt = new Date().toISOString();
      promoted += 1;
    }
  }

  // Bound the pending queue: keep the most confident, demote the rest back.
  const pending = list.filter((candidate) => candidate.status === STATUS.pending || candidate.status === STATUS.conflict);
  let demoted = 0;
  if (pending.length > config.maxPending) {
    const ordered = [...pending].sort((left, right) => (right.confidence || 0) - (left.confidence || 0));
    for (const candidate of ordered.slice(config.maxPending)) {
      candidate.status = STATUS.observing;
      demoted += 1;
    }
  }

  // Bound the observing pool: drop the oldest low-support entries.
  const observing = list.filter((candidate) => candidate.status === STATUS.observing);
  if (observing.length > config.maxObserving) {
    const ordered = [...observing].sort((left, right) => (right.support || 0) - (left.support || 0));
    for (const candidate of ordered.slice(config.maxObserving)) candidate.status = STATUS.archived;
  }
  return { promoted, demoted };
}

/**
 * Public projection of a candidate for the panel and tools.
 *
 * @param {any} candidate
 * @returns {object}
 */
export function publicCandidate(candidate) {
  return {
    id: String(candidate?.id ?? ''),
    draft: String(candidate?.draft ?? ''),
    status: String(candidate?.status ?? STATUS.observing),
    support: Number(candidate?.support ?? 0),
    sessions: Array.isArray(candidate?.sessions) ? candidate.sessions.length : 0,
    confidence: Number(candidate?.confidence ?? 0),
    scope: candidate?.scope === 'workspace' ? 'workspace' : 'global',
    workspace: candidate?.workspace ? String(candidate.workspace) : null,
    conflict: Boolean(candidate?.conflict),
    conflictWith: candidate?.conflictWith ? String(candidate.conflictWith) : null,
    createdAt: String(candidate?.createdAt ?? ''),
    lastSeenAt: String(candidate?.lastSeenAt ?? ''),
    evidence: Array.isArray(candidate?.evidence)
      ? candidate.evidence.slice(-3).map((entry) => ({
        userText: clip(entry?.userText ?? '', 200),
        at: String(entry?.at ?? ''),
        sessionId: entry?.sessionId ? String(entry.sessionId) : null,
        workspace: entry?.workspace ? String(entry.workspace) : null,
        assistantExcerpt: entry?.assistantExcerpt ? clip(entry.assistantExcerpt, 200) : null,
      }))
      : [],
  };
}

/**
 * Whether two texts are about the same habit (exported for tests).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameHabit(a, b) {
  return nearDuplicate(a, b);
}
