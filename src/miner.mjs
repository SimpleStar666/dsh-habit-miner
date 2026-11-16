/**
 * The miner: everything between "a signal arrived" and "a rule file changed".
 *
 * Kept free of host objects on purpose — it takes plain paths, config and signals,
 * so the whole decision path is unit-testable without DSH running.
 *
 * Invariants:
 *
 * - A rule file is only ever edited through {@link acceptCandidate} or
 *   {@link revokeRule}, and both snapshot the previous content first.
 * - A candidate never changes state without a review record.
 * - A failing file write leaves the candidate untouched, so the user can retry.
 *
 * @module dsh-habit-miner/miner
 */

import {
  appendJsonl,
  ensureStore,
  loadApplied,
  loadCandidates,
  readJson,
  readJsonl,
  saveApplied,
  saveCandidates,
  trimJsonl,
  writeJson,
  MAX_SIGNALS,
} from './store.mjs';
import {
  STATUS,
  confidenceOf,
  ingestSignal,
  makeSignal,
  publicCandidate,
  reconcileStatuses,
} from './candidates.mjs';
import { applyRules, globalAgentsPath, resolveTarget, workspaceAgentsPath } from './targets.mjs';
import { clip, hasNegation } from './text.mjs';

/** Maximum characters an accepted rule may carry. */
export const MAX_RULE_CHARS = 200;

/**
 * Load the miner's persisted state.
 *
 * @param {object} paths store paths
 * @returns {{candidates: any[], applied: {rules: any[], lastWrite: any}}}
 */
export function loadMiner(paths) {
  return { candidates: loadCandidates(paths), applied: loadApplied(paths) };
}

/**
 * Persist candidates and applied rules.
 *
 * @param {object} paths
 * @param {{candidates: any[], applied: {rules: any[], lastWrite: any}}} state
 * @returns {void}
 */
function saveMiner(paths, state) {
  saveCandidates(paths, state.candidates);
  saveApplied(paths, state.applied);
}

/**
 * Ingest one raw observation.
 *
 * @param {object} paths
 * @param {object} config normalized config
 * @param {object} raw signal input ({userText, assistantText, sessionId, workspace, at, channel})
 * @returns {{result: string, candidate: any|null, signal: object|null, promoted: number}}
 */
export function ingest(paths, config, raw) {
  ensureStore(paths);
  const signal = makeSignal(raw);
  if (!signal) return { result: 'ignored', candidate: null, signal: null, promoted: 0 };

  const state = loadMiner(paths);
  const outcome = ingestSignal(state.candidates, state.applied.rules, signal, config);
  const { promoted } = reconcileStatuses(state.candidates, config);
  saveMiner(paths, state);

  appendJsonl(paths.signals, {
    at: signal.at,
    sessionId: signal.sessionId,
    workspace: signal.workspace,
    kind: signal.kind,
    marker: signal.marker,
    draft: signal.draft,
    result: outcome.result,
    candidateId: outcome.candidate?.id ?? null,
    channel: signal.channel,
  });
  trimJsonl(paths.signals, MAX_SIGNALS);

  const stateFile = readJson(paths.state, {}) ?? {};
  writeJson(paths.state, {
    ...stateFile,
    lastSignalAt: signal.at,
    lastIngestAt: new Date().toISOString(),
    lastIngestResult: outcome.result,
    signals: (Number(stateFile.signals) || 0) + 1,
  });

  return { result: outcome.result, candidate: outcome.candidate, signal, promoted };
}

/**
 * Build the projection the panel renders.
 *
 * @param {object} paths
 * @param {object} config
 * @param {object} [context]
 * @param {string|null} [context.workspaceRoot] current session workspace
 * @param {boolean} [context.sessionQuery] whether a history backfill is possible
 * @param {any} [context.lastScan]
 * @returns {object}
 */
export function buildView(paths, config, context = {}) {
  const state = loadMiner(paths);
  const candidates = state.candidates || [];
  const pending = candidates
    .filter((candidate) => candidate.status === STATUS.pending || candidate.status === STATUS.conflict)
    .sort((left, right) => (right.confidence || 0) - (left.confidence || 0))
    .map(publicCandidate);
  const observing = candidates
    .filter((candidate) => candidate.status === STATUS.observing)
    .sort((left, right) => (right.support || 0) - (left.support || 0))
    .slice(0, 30)
    .map(publicCandidate);
  const applied = (state.applied.rules || []).map((rule) => ({
    id: rule.id,
    text: rule.text,
    scope: rule.scope === 'workspace' ? 'workspace' : 'global',
    workspace: rule.workspace ?? null,
    file: rule.file ?? null,
    at: rule.at ?? null,
    support: rule.support ?? 1,
    sessions: Array.isArray(rule.sessions) ? rule.sessions.length : 0,
  }));
  const stateFile = readJson(paths.state, {}) ?? {};

  return {
    ok: true,
    counts: {
      pending: pending.length,
      conflicts: pending.filter((candidate) => candidate.status === STATUS.conflict).length,
      observing: candidates.filter((candidate) => candidate.status === STATUS.observing).length,
      accepted: applied.length,
      signals: Number(stateFile.signals) || readJsonl(paths.signals).length,
    },
    pending,
    observing,
    applied,
    lastSignalAt: stateFile.lastSignalAt ?? null,
    lastScan: context.lastScan ?? readJson(paths.scanState, null)?.lastScan ?? null,
    storeDir: paths.dir,
    agents: {
      global: globalAgentsPath(),
      workspace: context.workspaceRoot ? workspaceAgentsPath(context.workspaceRoot) : null,
    },
    capabilities: {
      sessionQuery: Boolean(context.sessionQuery),
      backfill: Boolean(context.sessionQuery),
    },
    config: {
      capture: config.capture,
      minSessions: config.minSessions,
      minSupport: config.minSupport,
      scopeDefault: config.scopeDefault,
      scanDays: config.scanDays,
      maxPending: config.maxPending,
    },
  };
}

/**
 * Write one review record.
 *
 * @param {object} paths
 * @param {object} record
 * @returns {void}
 */
function appendReview(paths, record) {
  appendJsonl(paths.reviews, { at: new Date().toISOString(), ...record });
}

/**
 * Accept a candidate: write its rule into the target file and record the decision.
 *
 * @param {object} paths
 * @param {object} config
 * @param {{id: string, text?: string, scope?: string, workspace?: string|null}} input
 * @returns {{ok: boolean, status: number, message: string, rule?: object, requiresRead?: boolean}}
 */
export function acceptCandidate(paths, config, input) {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!id) return { ok: false, status: 400, message: '缺少 id。' };

  const state = loadMiner(paths);
  const candidate = (state.candidates || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, status: 404, message: '没找到这条候选。' };

  const text = typeof input?.text === 'string' && input.text.trim() ? input.text.trim() : String(candidate.draft ?? '').trim();
  if (text.length < 4) return { ok: false, status: 400, message: '规则太短，至少 4 个字。' };
  if (text.length > MAX_RULE_CHARS) return { ok: false, status: 400, message: `规则太长，最多 ${MAX_RULE_CHARS} 字。` };

  // The panel may override the scope and the workspace a rule belongs to.
  const scope = input?.scope === 'workspace' || input?.scope === 'global' ? input.scope : (candidate.scope === 'workspace' ? 'workspace' : 'global');
  const workspace = input?.workspace === null ? null : (typeof input?.workspace === 'string' && input.workspace ? input.workspace : candidate.workspace);
  const target = resolveTarget({ scope, workspace });
  if (scope === 'workspace' && !target.workspace) {
    return { ok: false, status: 400, message: '选「本工作区」时需要先知道工作区目录。' };
  }

  const rulesForFile = (state.applied.rules || []).filter((rule) => rule.file === target.file && rule.id !== id);
  const rule = {
    id,
    text,
    scope: target.scope,
    workspace: target.workspace,
    file: target.file,
    at: new Date().toISOString(),
    support: candidate.support ?? 1,
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions : [],
    candidateId: candidate.id,
  };

  let written;
  try {
    written = applyRules({
      paths,
      file: target.file,
      rules: [...rulesForFile, rule],
      reason: `accept ${id}`,
    });
  } catch (error) {
    return { ok: false, status: 500, message: `写入规则文件失败：${error?.message ?? error}` };
  }

  state.applied = {
    rules: [...(state.applied.rules || []).filter((entry) => entry.file !== target.file || entry.id !== id), rule],
    lastWrite: { at: rule.at, file: target.file, changed: written.changed, snapshot: written.snapshot },
  };
  candidate.status = STATUS.accepted;
  candidate.acceptedAt = rule.at;
  candidate.updatedAt = rule.at;
  candidate.appliedFile = target.file;
  saveMiner(paths, state);
  appendReview(paths, { id, action: 'accept', text, scope: target.scope, file: target.file, snapshot: written.snapshot });

  return {
    ok: true,
    status: 200,
    message: `已写入 ${target.file}。DSH 没有 watcher：下一次读取该目录、或新开会话时生效。`,
    rule: { id: rule.id, text: rule.text, scope: rule.scope, file: rule.file },
    requiresRead: !written.changed,
  };
}

/**
 * Reject a candidate: it disappears from the queue and stays suppressed for a while.
 *
 * @param {object} paths
 * @param {{id: string, reason?: string}} input
 * @returns {{ok: boolean, status: number, message: string}}
 */
export function rejectCandidate(paths, input) {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!id) return { ok: false, status: 400, message: '缺少 id。' };
  const state = loadMiner(paths);
  const candidate = (state.candidates || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, status: 404, message: '没找到这条候选。' };
  candidate.status = STATUS.rejected;
  candidate.updatedAt = new Date().toISOString();
  saveMiner(paths, state);
  appendReview(paths, { id, action: 'reject', reason: clip(input?.reason ?? '', 200) });
  return { ok: true, status: 200, message: '已忽略，同类候选 30 天内不会再冒出来。' };
}

/**
 * Remove an accepted rule from its file.
 *
 * @param {object} paths
 * @param {{id: string}} input
 * @returns {{ok: boolean, status: number, message: string}}
 */
export function revokeRule(paths, input) {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!id) return { ok: false, status: 400, message: '缺少 id。' };
  const state = loadMiner(paths);
  const rule = (state.applied.rules || []).find((entry) => entry.id === id);
  if (!rule) return { ok: false, status: 404, message: '没找到这条已应用的规则。' };

  const remaining = (state.applied.rules || []).filter((entry) => entry.file === rule.file && entry.id !== id);
  let written;
  try {
    written = applyRules({ paths, file: rule.file, rules: remaining, reason: `revoke ${id}` });
  } catch (error) {
    return { ok: false, status: 500, message: `撤销失败：${error?.message ?? error}` };
  }

  state.applied = {
    rules: (state.applied.rules || []).filter((entry) => entry.id !== id),
    lastWrite: { at: new Date().toISOString(), file: rule.file, changed: written.changed, snapshot: written.snapshot },
  };
  const candidate = (state.candidates || []).find((entry) => entry.id === id);
  if (candidate) {
    candidate.status = STATUS.archived;
    candidate.updatedAt = new Date().toISOString();
  }
  saveMiner(paths, state);
  appendReview(paths, { id, action: 'revoke', text: rule.text, file: rule.file, snapshot: written.snapshot });
  return { ok: true, status: 200, message: `已从 ${rule.file} 移除。` };
}

/**
 * Whether a candidate's draft conflicts with an accepted rule (used by the panel
 * summary, and by tests).
 *
 * @param {any[]} appliedRules
 * @param {string} text
 * @returns {any|null}
 */
export function findConflict(appliedRules, text) {
  for (const rule of appliedRules || []) {
    if (!rule?.text) continue;
    const left = String(rule.text);
    if (hasNegation(left) === hasNegation(text)) continue;
    if (typeof rule.text === 'string' && rule.text.length && text.length) {
      // Reuse the candidate module's similarity check through a cheap import-free path:
      // conflicts are only reported when the panel asks, so a normalized-prefix match is enough.
      const a = left.replace(/\s+/g, '').slice(0, 12);
      const b = String(text).replace(/\s+/g, '').slice(0, 12);
      if (a && b && (a.includes(b) || b.includes(a))) return rule;
    }
  }
  return null;
}

/**
 * Recompute confidence for every candidate (after an applied rule changed).
 *
 * @param {object} paths
 * @param {object} config
 * @returns {void}
 */
export function refreshConfidences(paths, config) {
  const state = loadMiner(paths);
  for (const candidate of state.candidates || []) {
    if (candidate.status === STATUS.accepted || candidate.status === STATUS.archived) continue;
    candidate.confidence = confidenceOf({
      support: candidate.support || 0,
      sessions: Array.isArray(candidate.sessions) ? candidate.sessions.length : 0,
      kind: candidate.kind,
      conflict: Boolean(candidate.conflict),
    });
  }
  saveCandidates(paths, state.candidates);
  void config;
}

/**
 * Hide one observing candidate without a full rejection (panel convenience).
 *
 * @param {object} paths
 * @param {{id: string}} input
 * @returns {{ok: boolean, status: number, message: string}}
 */
export function hideCandidate(paths, input) {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!id) return { ok: false, status: 400, message: '缺少 id。' };
  const state = loadMiner(paths);
  const candidate = (state.candidates || []).find((entry) => entry.id === id);
  if (!candidate) return { ok: false, status: 404, message: '没找到这条候选。' };
  candidate.status = STATUS.archived;
  candidate.updatedAt = new Date().toISOString();
  saveMiner(paths, state);
  appendReview(paths, { id, action: 'hide' });
  return { ok: true, status: 200, message: '已收进观察区不再显示。' };
}