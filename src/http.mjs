/**
 * HTTP surface for the browser panel: one read endpoint and one action endpoint.
 *
 * The same discipline as the persona plugin: an allowlist of verbs, ids validated
 * against the store rather than trusted, text length capped, and nothing here can
 * write outside the rule files the miner owns.
 *
 * @module dsh-habit-miner/http
 */

import { acceptCandidate, buildView, rejectCandidate, revokeRule } from './miner.mjs';

/** Path registered on the host fetch router. */
export const STATE_PATH = '/api/habit-miner/state';

/** Path that applies one panel action. */
export const ACTION_PATH = '/api/habit-miner/action';

/** Actions the panel may perform. */
export const ACTIONS = ['refresh', 'scan', 'accept', 'reject', 'revoke', 'hide'];

/**
 * Build the whole state snapshot the panel renders.
 *
 * @param {object} input
 * @param {object} input.paths store paths
 * @param {object} input.config normalized config
 * @param {object} [input.context] `{workspaceRoot, sessionQuery, lastScan}`
 * @returns {object}
 */
export function buildState({ paths, config, context }) {
  try {
    return { ...buildView(paths, config, context ?? {}), ok: true };
  } catch (error) {
    return { ok: false, error: `读取失败：${error?.message ?? error}` };
  }
}

/**
 * Apply one action and return the outcome plus fresh state.
 *
 * @param {object} input
 * @param {object} input.paths
 * @param {object} input.config
 * @param {object} input.body parsed JSON body
 * @param {object} [input.context]
 * @param {() => Promise<object>} [input.runScan] history backfill runner
 * @returns {Promise<{status: number, body: object}>}
 */
export async function applyAction({ paths, config, body, context, runScan }) {
  const action = typeof body?.action === 'string' ? body.action : '';
  if (!ACTIONS.includes(action)) {
    return { status: 400, body: { ok: false, error: `未知 action：${action || '(空)'}` } };
  }

  if (action === 'refresh') {
    return { status: 200, body: buildState({ paths, config, context }) };
  }

  if (action === 'scan') {
    if (typeof runScan !== 'function') {
      return { status: 200, body: { ok: true, message: '没有可用的会话历史接口，只能从新对话里收集。', ...buildState({ paths, config, context }) } };
    }
    let scan;
    try {
      scan = await runScan();
    } catch (error) {
      return { status: 200, body: { ok: false, error: `扫描失败：${error?.message ?? error}`, ...buildState({ paths, config, context }) } };
    }
    return { status: 200, body: { ok: true, scan, message: scanMessage(scan), ...buildState({ paths, config, context }) } };
  }

  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return { status: 400, body: { ok: false, error: '缺少 id。' } };

  if (action === 'accept') {
    const result = acceptCandidate(paths, config, {
      id,
      text: typeof body?.text === 'string' ? body.text : undefined,
      scope: typeof body?.scope === 'string' ? body.scope : undefined,
      workspace: body?.workspace === null ? null : (typeof body?.workspace === 'string' ? body.workspace : undefined),
    });
    return { status: result.status, body: { ...result, state: buildState({ paths, config, context }) } };
  }

  if (action === 'reject') {
    const result = rejectCandidate(paths, { id, reason: typeof body?.reason === 'string' ? body.reason : '' });
    return { status: result.status, body: { ...result, state: buildState({ paths, config, context }) } };
  }

  if (action === 'revoke') {
    const result = revokeRule(paths, { id });
    return { status: result.status, body: { ...result, state: buildState({ paths, config, context }) } };
  }

  if (action === 'hide') {
    const { hideCandidate } = await import('./miner.mjs');
    const result = hideCandidate(paths, { id });
    return { status: result.status, body: { ...result, state: buildState({ paths, config, context }) } };
  }

  return { status: 400, body: { ok: false, error: '未处理的动作。' } };
}

/**
 * One sentence describing a backfill result.
 *
 * @param {object} scan
 * @returns {string}
 */
function scanMessage(scan) {
  if (!scan) return '扫描完成。';
  if (scan.ok === false) {
    if (scan.reason === 'no-session-query') return '这个环境没有会话历史接口，只能从新对话里收集。';
    return `扫描没有完成：${scan.reason}`;
  }
  if ((scan.sessions || 0) === 0) return '没有新会话可扫（已经扫过的会话会跳过）。';
  return `扫了 ${scan.sessions} 个会话、${scan.events} 条消息，新增 ${scan.signals} 条线索。`;
}

/**
 * Wrap a JSON value as a Response, tolerating a host without the global Response.
 *
 * @param {object} value
 * @param {number} [status]
 * @returns {any}
 */
export function jsonResponse(value, status = 200) {
  const payload = JSON.stringify(value);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (typeof Response === 'function') return new Response(payload, { status, headers });
  return {
    status,
    headers,
    json: async () => JSON.parse(payload),
    text: async () => payload,
  };
}
