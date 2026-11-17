/**
 * Config schema as a Standard Schema, so cordis can validate it without this
 * package depending on schemastery at runtime.
 *
 * The plugin targets machines where nothing may be built or approved, so the
 * dependency surface stays at zero: a hand-written validator covers the six
 * fields actually used.
 *
 * @module dsh-habit-miner/schema
 */

/** Defaults, also the documented behaviour in README and DETAIL. */
export const DEFAULTS = Object.freeze({
  /** Master switch. */
  enabled: true,
  /** Store directory; empty means `<DSH_HOME>/habit-miner`. */
  storeDir: '',
  /** Capture corrections from the live conversation at turn end. */
  capture: true,
  /** Ignore user messages shorter than this when capturing. */
  captureMinChars: 6,
  /** Promote an observed habit once it appeared in at least this many sessions. */
  minSessions: 2,
  /** Also require at least this many total occurrences. */
  minSupport: 2,
  /** Stop queueing new candidates past this many pending items. */
  maxPending: 60,
  /** How many `observing` candidates to keep (ones below the session threshold). */
  maxObserving: 200,
  /** Run one history backfill when the plugin activates for the first time after a day. */
  scanOnFirstRun: true,
  /** Backfill window, in days. */
  scanDays: 60,
  /** Never replay more than this many sessions in one backfill. */
  scanMaxSessions: 120,
  /** Default target for an accepted rule: `global` (`<DSH_HOME>/AGENTS.md`) or `workspace`. */
  scopeDefault: 'global',
  /** Show a one-line status in the system prompt while candidates are waiting. */
  injectHint: true,
  /** Section order inside the system prompt; after the persona/instructions blocks. */
  order: 960,
  /** Write a debug log next to the store. */
  debugLog: false,
  /** Allow the model-facing habit_accept tool to write rules; panel approval remains the default. */
  allowToolAccept: false,
});

const BOOLEAN_KEYS = ['enabled', 'capture', 'scanOnFirstRun', 'injectHint', 'debugLog', 'allowToolAccept'];
const NUMBER_KEYS = [
  'captureMinChars', 'minSessions', 'minSupport', 'maxPending', 'maxObserving',
  'scanDays', 'scanMaxSessions', 'order',
];

/**
 * Normalise untrusted config into the documented shape. Unknown keys are dropped;
 * a wrong type falls back to the default rather than failing activation.
 *
 * @param {unknown} raw config as provided by the loader
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULTS };
  for (const key of BOOLEAN_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key];
  }
  for (const key of NUMBER_KEYS) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) out[key] = value;
  }
  if (typeof source.storeDir === 'string') out.storeDir = source.storeDir.trim();
  if (source.scopeDefault === 'workspace' || source.scopeDefault === 'global') {
    out.scopeDefault = source.scopeDefault;
  }
  out.captureMinChars = Math.max(1, Math.min(200, Math.trunc(out.captureMinChars)));
  out.minSessions = Math.max(1, Math.min(20, Math.trunc(out.minSessions)));
  out.minSupport = Math.max(1, Math.min(100, Math.trunc(out.minSupport)));
  out.maxPending = Math.max(5, Math.min(500, Math.trunc(out.maxPending)));
  out.maxObserving = Math.max(10, Math.min(2000, Math.trunc(out.maxObserving)));
  out.scanDays = Math.max(1, Math.min(365, Math.trunc(out.scanDays)));
  out.scanMaxSessions = Math.max(1, Math.min(500, Math.trunc(out.scanMaxSessions)));
  out.order = Math.max(0, Math.min(9000, Math.trunc(out.order)));
  return out;
}

/**
 * Standard Schema wrapper consumed by cordis at activation time.
 *
 * @type {{'~standard': {version: number, vendor: string, validate: (value: unknown) => {value: typeof DEFAULTS}}}}
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-habit-miner',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: `配置无效：${error?.message ?? String(error)}`, path: [] }] };
      }
    },
  },
};
