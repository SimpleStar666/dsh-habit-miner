/**
 * Host half: capture corrections from live turns, backfill history through the
 * session-query service, serve the panel, register the model-facing tools, and
 * keep a one-line status in the system prompt.
 *
 * Hosts facts this file relies on, each checked against this DSH version:
 *
 * - `session/event` arrives with `{global: true}`; without the option the scope
 *   filter drops every session except the one the context belongs to.
 * - `session.deriveMessages()` returns the same transcript the agent loop used.
 * - `sessionQuery` exists in the base profile because `session-query-sqlite` is
 *   mounted with `openAt: never`: exact reads work, SQLite search stays off.
 * - `ctx.connection.fetch.register({path, methods, requestBody, fetch})` serves
 *   the panel's two JSON endpoints.
 * - Nothing throws out of a hook: a failed capture costs one skipped observation.
 *
 * @module dsh-habit-miner/plugin
 */

import { Config, normalizeConfig } from './schema.mjs';
import { appendJsonl, readJson, resolvePaths, ensureStore, writeJson } from './store.mjs';
import { acceptCandidate, buildView, ingest, rejectCandidate } from './miner.mjs';
import { ACTION_PATH, STATE_PATH, applyAction, buildState, jsonResponse } from './http.mjs';
import { scanHistory } from './scan.mjs';
import { createToolSpecs } from './tools.mjs';
import { compileToolDefinition } from './compile.mjs';

export { Config };

/** Plugin name (DSH plugin contract). */
export const name = 'dsh-habit-miner';

/** Services this plugin needs; everything else is probed defensively. */
export const inject = ['tools', 'systemPrompt', 'sessions', 'connection'];

/** System-prompt section name. */
const SECTION_NAME = 'habit-miner';

/** Delay before the automatic first backfill, so boot is never blocked. */
const FIRST_SCAN_DELAY_MS = 8000;

/**
 * Pull plain text out of whatever the host hands us as a message.
 *
 * @param {any} message
 * @returns {string}
 */
export function extractMessageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message.trim();
  if (typeof message.text === 'string') return message.text.trim();
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * The session's cwd, wherever the host currently keeps it.
 *
 * @param {any} session
 * @returns {string|null}
 */
export function sessionWorkspace(session) {
  const header = session?.header ?? {};
  const value = header.cwd ?? header.workingDirectory ?? header.projectPath;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Return the stable refusal used when the model-facing write tool is disabled.
 *
 * The panel is the default approval boundary. Keeping this check in the host
 * adapter (rather than only in the tool description) means a model cannot write
 * an AGENTS.md rule merely by deciding to call `habit_accept`.
 *
 * @param {object} config normalized plugin config
 * @returns {{ok: false, message: string}|null}
 */
export function toolAcceptDisabled(config) {
  return config?.allowToolAccept === true
    ? null
    : { ok: false, message: '为安全起见，模型工具默认不能写规则；请在习惯面板点击「采纳」，或显式开启 allowToolAccept。' };
}

/**
 * Apply the plugin to a host context.
 *
 * @param {any} ctx cordis plugin context
 * @param {any} rawConfig plugin config from the loader
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;
  if (!ctx || typeof ctx?.tools?.register !== 'function') {
    throw new Error('dsh-habit-miner: 需要 ctx.tools.register（inject: ["tools"]），但宿主未提供。');
  }

  const paths = resolvePaths({ storeDir: config.storeDir });
  ensureStore(paths);

  const debug = (message) => {
    if (!config.debugLog) return;
    try {
      writeJson(`${paths.dir}/debug.json`, { at: new Date().toISOString(), message });
      appendJsonl(`${paths.dir}/debug.log.jsonl`, { at: new Date().toISOString(), message });
    } catch { /* diagnostics only */ }
  };
  const warn = (message) => debug(`WARN ${message}`);

  /** sessionId -> how many user messages were already handled */
  const seen = new Map();
  /** single-flight guard for history backfill */
  let scanInFlight = null;
  /** last backfill result, for the panel */
  let lastScan = readJson(paths.scanState, null)?.lastScan ?? null;

  const getSessionQuery = () => {
    try {
      const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null;
      if (query && typeof query.filterSessions === 'function') return query;
    } catch { /* service absent */ }
    try {
      return ctx.sessionQuery && typeof ctx.sessionQuery.filterSessions === 'function' ? ctx.sessionQuery : null;
    } catch {
      return null;
    }
  };

  const getSession = (sessionId) => {
    try {
      if (!sessionId || typeof ctx.sessions?.get !== 'function') return null;
      return ctx.sessions.get(sessionId) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Backfill the recent history once, bounded by config.
   *
   * @param {{days?: number}} [options]
   * @returns {Promise<object>}
   */
  const runScan = (options = {}) => {
    if (scanInFlight) return scanInFlight;
    const query = getSessionQuery();
    const days = Number(options?.days);
    const scanConfig = Number.isFinite(days) && days > 0
      ? { ...config, scanDays: Math.max(1, Math.min(365, Math.trunc(days))) }
      : config;

    scanInFlight = (async () => {
      const previous = readJson(paths.scanState, {}) ?? {};
      const scanned = previous.scanned && typeof previous.scanned === 'object' ? { ...previous.scanned } : {};
      const stats = await scanHistory({
        query,
        config: scanConfig,
        skipSession: (sessionId) => Boolean(scanned[sessionId]),
        onSignal: (raw) => {
          try {
            const result = ingest(paths, config, raw);
            return Boolean(result.signal);
          } catch (error) {
            warn(`scan ingest failed: ${error?.message ?? error}`);
            return false;
          }
        },
        onSession: (sessionId) => {
          scanned[sessionId] = { at: new Date().toISOString() };
        },
        onUserMessage: (message) => {
          if (!config.debugLog) return;
          try {
            appendJsonl(`${paths.dir}/debug-messages.jsonl`, message);
          } catch { /* diagnostics only */ }
        },
      });
      lastScan = { at: new Date().toISOString(), ...stats };
      // Keep the bookkeeping bounded: sessions older than the window fall out.
      const keepAfter = Date.now() - Math.max(1, Number(config.scanDays) || 30) * 2 * 86_400_000;
      for (const [sessionId, record] of Object.entries(scanned)) {
        const at = Date.parse(String(record?.at ?? ''));
        if (Number.isFinite(at) && at < keepAfter) delete scanned[sessionId];
      }
      try {
        writeJson(paths.scanState, { ...previous, scanned, lastScan });
      } catch { /* advisory only */ }
      return stats;
    })();

    return scanInFlight.finally(() => {
      scanInFlight = null;
    });
  };

  const contextFor = (sessionId) => {
    const session = getSession(sessionId);
    return {
      workspaceRoot: session ? sessionWorkspace(session) : null,
      sessionQuery: Boolean(getSessionQuery()),
      lastScan,
    };
  };

  // ---- tools ---------------------------------------------------------------

  const toolApi = {
    scan: async (args = {}) => {
      const stats = await runScan({ days: args?.days });
      const view = buildView(paths, config, contextFor(null));
      return {
        ok: stats?.ok !== false,
        sessions: Number(stats?.sessions ?? 0),
        events: Number(stats?.events ?? 0),
        signals: Number(stats?.signals ?? 0),
        message: stats?.ok === false
          ? (stats.reason === 'no-session-query' ? '这个环境没有会话历史接口，只能从新对话里收集。' : `扫描失败：${stats.reason}`)
          : `扫了 ${stats.sessions} 个会话，新增 ${stats.signals} 条线索；待确认 ${view.counts.pending} 条。`,
      };
    },
    list: (args = {}) => {
      const view = buildView(paths, config, contextFor(null));
      const status = args?.status === 'observing' ? 'observing' : 'pending';
      const source = status === 'observing' ? view.observing : view.pending;
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
      const items = source.slice(0, limit).map((item) => ({
        id: item.id,
        draft: item.draft,
        sessions: item.sessions,
        support: item.support,
        confidence: item.confidence,
        scope: item.scope,
        conflict: item.conflict,
        evidence: item.evidence.slice(0, 2).map((entry) => entry.userText),
      }));
      return {
        ok: true,
        count: items.length,
        items,
        message: items.length
          ? items.map((item) => `- ${item.id}：${item.draft}（${item.sessions} 个会话，支持 ${item.support} 次）`).join('\n')
          : (status === 'observing' ? '还没有观察中的候选。' : '没有待确认的习惯。'),
      };
    },
    accept: (args = {}) => {
      const disabled = toolAcceptDisabled(config);
      if (disabled) return { ...disabled, pending: buildView(paths, config, contextFor(null)).counts.pending };
      try {
        const session = args?.sessionId ? getSession(args.sessionId) : null;
        const result = acceptCandidate(paths, config, {
          id: args?.id,
          text: args?.text,
          scope: args?.scope,
          workspace: args?.workspace ?? (session ? sessionWorkspace(session) : null),
        });
        const view = buildView(paths, config, contextFor(null));
        return { ok: result.ok, message: result.message, pending: view.counts.pending };
      } catch (error) {
        return { ok: false, message: `写入失败：${error?.message ?? error}` };
      }
    },
    reject: (args = {}) => {
      try {
        const result = rejectCandidate(paths, { id: args?.id, reason: args?.reason });
        const view = buildView(paths, config, contextFor(null));
        return { ok: result.ok, message: result.message, pending: view.counts.pending };
      } catch (error) {
        return { ok: false, message: `忽略失败：${error?.message ?? error}` };
      }
    },
  };

  const defineTool = typeof ctx.tools.defineTool === 'function' ? ctx.tools.defineTool : null;
  for (const spec of createToolSpecs(toolApi)) {
    try {
      const definition = defineTool ? defineTool(spec) : compileToolDefinition(spec);
      ctx.tools.register(definition);
    } catch (error) {
      warn(`register tool ${spec.name} failed: ${error?.message ?? error}`);
    }
  }

  // ---- system prompt hint --------------------------------------------------

  if (config.injectHint && typeof ctx.systemPrompt?.section === 'function') {
    const renderHint = () => {
      try {
        const view = buildView(paths, config, contextFor(null));
        if (view.counts.pending === 0) return '';
        return [
          '【习惯挖掘器】',
          `有 ${view.counts.pending} 条待确认的习惯（来自用户反复纠正你的地方）。`,
          config.allowToolAccept
            ? '用 habit_list 查看；用户明确同意后用 habit_accept 写入 AGENTS.md。'
            : '用 habit_list 查看并帮助分析证据；最终请用户在习惯面板点击「采纳」。模型工具不能直接写入规则。',
          '不要自己替用户确认。',
        ].join('');
      } catch {
        return '';
      }
    };
    try {
      const register = () => ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: config.order,
        text: renderHint,
      });
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-habit-miner:section');
      else register();
    } catch (error) {
      warn(`register section failed: ${error?.message ?? error}`);
    }
  }

  // ---- HTTP surface for the panel -----------------------------------------

  // `connection` is a web-carrier service; a headless profile does not have it,
  // and reading an undeclared service throws, so it is probed through ctx.get.
  const getConnection = () => {
    try {
      const connection = ctx.connection;
      if (connection && typeof connection.fetch?.register === 'function') return connection;
    } catch { /* service absent */ }
    return null;
  };

  const connection = getConnection();
  debug(`connection service: ${connection ? 'available' : 'missing'}`);
  if (connection) {
    try {
      ctx.effect(() => {
        const handle = async (request) => {
          try {
            const pathname = (() => {
              try {
                return new URL(request.url, 'http://localhost').pathname;
              } catch {
                return '';
              }
            })();
            const sessionId = (() => {
              try {
                return new URL(request.url, 'http://localhost').searchParams.get('session') ?? '';
              } catch {
                return '';
              }
            })();

            debug(`request ${request.method} ${request.url}`);
            if (pathname === STATE_PATH) {
              if (request.method !== 'GET' && request.method !== 'POST') {
                return jsonResponse({ ok: false, error: '方法不允许。' }, 405);
              }
              return jsonResponse(buildState({ paths, config, context: contextFor(sessionId) }));
            }
            if (pathname === ACTION_PATH) {
              if (request.method !== 'POST') return jsonResponse({ ok: false, error: '方法不允许。' }, 405);
              let body;
              try {
                body = await request.json();
              } catch {
                return jsonResponse({ ok: false, error: '请求体不是合法 JSON。' }, 400);
              }
              const session = body?.sessionId ? getSession(String(body.sessionId)) : null;
              const context = {
                workspaceRoot: session ? sessionWorkspace(session) : null,
                sessionQuery: Boolean(getSessionQuery()),
                lastScan,
              };
              const result = await applyAction({ paths, config, body, context, runScan });
              return jsonResponse(result.body, result.status);
            }
            return jsonResponse({ ok: false, error: '未找到。' }, 404);
          } catch (error) {
            return jsonResponse({ ok: false, error: `内部错误：${error?.message ?? error}` }, 500);
          }
        };

        const disposers = [STATE_PATH, ACTION_PATH].map((path) => connection.fetch.register({
          path,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: handle,
        }));
        return () => {
          for (const dispose of disposers) {
            try { dispose?.(); } catch { /* ignore */ }
          }
        };
      }, 'dsh-habit-miner:http');
      debug('http routes registered');
    } catch (error) {
      warn(`register routes failed: ${error?.message ?? error}`);
    }
  }

  // ---- live capture --------------------------------------------------------

  const captureTurn = (session) => {
    try {
      if (!config.capture) return;
      const header = session?.header;
      if (header && (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0))) return;
      if (typeof session?.deriveMessages !== 'function') return;

      const messages = session.deriveMessages();
      if (!Array.isArray(messages) || messages.length === 0) return;
      const sessionId = typeof session.id === 'string' ? session.id : 'unknown';
      const workspace = sessionWorkspace(session);

      const userCount = messages.filter((message) => message?.role === 'user').length;
      const previous = seen.get(sessionId) ?? 0;
      const skip = Math.max(0, Math.min(previous, userCount));
      seen.set(sessionId, userCount);
      if (skip >= userCount) return;

      let assistantText = '';
      let userIndex = 0;
      let produced = 0;
      for (const message of messages) {
        if (!message) continue;
        if (message.role === 'assistant') {
          const text = extractMessageText(message);
          if (text) assistantText = text;
          continue;
        }
        if (message.role !== 'user') continue;
        userIndex += 1;
        if (userIndex <= skip) {
          const text = extractMessageText(message);
          if (text) assistantText = '';
          continue;
        }
        const text = extractMessageText(message);
        if (text && text.length >= config.captureMinChars) {
          const result = ingest(paths, config, {
            userText: text,
            assistantText,
            sessionId,
            workspace,
            at: new Date().toISOString(),
            channel: 'live',
          });
          if (result.signal) produced += 1;
        }
        assistantText = '';
      }
      if (produced > 0) debug(`turn/end captured ${produced} signal(s) from ${sessionId}`);
    } catch (error) {
      warn(`capture failed: ${error?.message ?? error}`);
    }
  };

  const subscribe = (event, handler, options) => {
    try {
      const dispose = options ? ctx.on(event, handler, options) : ctx.on(event, handler);
      return typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      warn(`subscribe ${event} failed: ${error?.message ?? error}`);
      return null;
    }
  };

  const disposers = [
    subscribe('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'turn/end') return;
        captureTurn(session);
      } catch (error) {
        warn(`session/event failed: ${error?.message ?? error}`);
      }
    }, { global: true }),
    subscribe('agent/disposed', ({ agent } = {}) => {
      try {
        if (agent && typeof agent.id === 'string') seen.delete(agent.id);
      } catch { /* ignore */ }
    }),
  ].filter(Boolean);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      seen.clear();
    });
  }

  // ---- one automatic backfill ---------------------------------------------

  if (config.scanOnFirstRun) {
    const last = lastScan?.at ? Date.parse(lastScan.at) : 0;
    const stale = !last || Date.now() - last > 86_400_000;
    if (stale) {
      const timer = setTimeout(() => {
        void runScan().then((stats) => {
          if (stats?.ok) debug(`first backfill: ${stats.sessions} sessions, ${stats.signals} signals`);
          else debug(`first backfill skipped: ${stats?.reason ?? 'unknown'}`);
        }).catch((error) => {
          warn(`first backfill failed: ${error?.message ?? error}`);
        });
      }, FIRST_SCAN_DELAY_MS);
      if (typeof timer?.unref === 'function') timer.unref();
    }
  }
}
