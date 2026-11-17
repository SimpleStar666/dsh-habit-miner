/**
 * The rule files this plugin may edit, and the managed block inside them.
 *
 * DSH loads instruction files from `<DSH_HOME>/AGENTS.md`, `<DSH_AGENTS_HOME>/AGENTS.md`
 * and then every `AGENTS.md` / `CLAUDE.md` (+ `.local` variants) from the project
 * root down to the session cwd. There is no watcher: a write becomes visible to the
 * model when a first-party `read`/`write`/`edit` touches that directory, when the
 * session resumes, or in the next session. The panel says so instead of promising
 * instant effect.
 *
 * The plugin only ever edits one marked block, so everything above and below it —
 * including the user's hand-written rules — is preserved byte for byte.
 *
 * @module dsh-habit-miner/targets
 */

import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { atomicWrite, readTextFile, snapshotFile } from './store.mjs';

/** Marker that opens the managed block. */
export const BLOCK_BEGIN = '<!-- habit-miner:begin — maintained by the habit miner; delete this line to stop managing the block -->';

/** Marker that closes the managed block. */
export const BLOCK_END = '<!-- habit-miner:end -->';

/** Prefix of a per-rule id marker inside the block. */
const ID_PREFIX = '<!-- habit:';

/**
 * Resolve the DSH home directory the way the rest of the host does.
 *
 * @returns {string}
 */
export function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
}

/**
 * Absolute path of the global instruction file.
 *
 * @returns {string}
 */
export function globalAgentsPath() {
  return join(dshHome(), 'AGENTS.md');
}

/**
 * Absolute path of the workspace instruction file.
 *
 * @param {string} workspaceRoot absolute workspace directory
 * @returns {string}
 */
export function workspaceAgentsPath(workspaceRoot) {
  return join(String(workspaceRoot || ''), 'AGENTS.md');
}

/**
 * Resolve the file a rule with the given scope writes to.
 *
 * @param {{scope: string, workspace?: string|null}} rule
 * @returns {{file: string, scope: string, workspace: string|null}}
 */
export function resolveTarget(rule) {
  const scope = rule.scope === 'workspace' ? 'workspace' : 'global';
  if (scope === 'workspace' && rule.workspace) {
    return { file: workspaceAgentsPath(rule.workspace), scope, workspace: String(rule.workspace) };
  }
  return { file: globalAgentsPath(), scope: 'global', workspace: null };
}

/**
 * Render one managed line.
 *
 * @param {{id: string, text: string}} rule
 * @returns {string}
 */
export function managedLine(rule) {
  return `- ${rule.text} ${ID_PREFIX}${rule.id} -->`;
}

/**
 * Render the whole managed block for a set of rules.
 *
 * @param {{id: string, text: string}[]} rules
 * @returns {string} block text, or '' when there is nothing to manage
 */
export function renderBlock(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  return [BLOCK_BEGIN, ...rules.map(managedLine), BLOCK_END].join('\n');
}

/**
 * Locate and parse the managed block inside a file's content.
 *
 * @param {string} content file content
 * @returns {{found: boolean, start: number, end: number, preamble: string, postamble: string, rules: {id: string, text: string}[]}}
 */
export function readBlock(content) {
  const text = String(content ?? '');
  const start = text.indexOf(BLOCK_BEGIN);
  if (start < 0) return { found: false, start: -1, end: -1, preamble: text, postamble: '', rules: [] };
  const endMarker = text.indexOf(BLOCK_END, start);
  const end = endMarker < 0 ? -1 : endMarker + BLOCK_END.length;
  const inner = endMarker < 0 ? '' : text.slice(start + BLOCK_BEGIN.length, endMarker);
  const rules = [];
  for (const line of inner.split('\n')) {
    const value = line.trim();
    if (!value.startsWith('- ')) continue;
    const idMatch = value.match(/<!-- habit:([A-Za-z0-9_-]+) -->\s*$/);
    if (!idMatch) continue;
    const ruleText = value.slice(2, idMatch.index).trim();
    if (!ruleText) continue;
    rules.push({ id: idMatch[1], text: ruleText });
  }
  return {
    found: true,
    start,
    end,
    preamble: end < 0 ? '' : text.slice(0, start),
    postamble: end < 0 ? '' : text.slice(end),
    rules,
  };
}

/**
 * Replace (or append) the managed block in a file's content.
 * Existing content outside the marker span is never trimmed or normalized.
 * Ambiguous/incomplete marker pairs are rejected, including when deleting rules.
 *
 * @param {string} content existing file content
 * @param {{id: string, text: string}[]} rules rules that should be in the block
 * @returns {string} the new file content
 * @throws {Error} when managed block markers are missing, reversed or repeated
 */
export function writeBlock(content, rules) {
  const text = String(content ?? '');
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  const hasMarkers = start >= 0 || end >= 0;
  if (hasMarkers && (
    start < 0 || end < start ||
    text.indexOf(BLOCK_BEGIN, start + BLOCK_BEGIN.length) >= 0 ||
    text.indexOf(BLOCK_END, end + BLOCK_END.length) >= 0
  )) {
    throw new Error('Invalid habit-miner managed block markers; refusing to modify content');
  }

  const newline = text.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const block = renderBlock(rules).replace(/\r?\n/g, newline);
  if (hasMarkers) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  }
  if (!block) return text;

  // Append at a fresh paragraph without consuming any existing bytes. Reuse
  // existing trailing blank lines, but finish a whitespace-only last line first.
  const trailingWhitespace = text.match(/[ \t\r\n]*$/)[0];
  const lineBreaks = trailingWhitespace.match(/\r\n|\n|\r/g)?.length ?? 0;
  const separator = !text || text === '\uFEFF' ? ''
    : lineBreaks === 0 ? newline + newline
      : /[\r\n]$/.test(text) && lineBreaks >= 2 ? '' : newline;
  return text + separator + block + newline;
}

/**
 * Apply a rule set to a file on disk, snapshotting the previous content first.
 *
 * @param {object} input
 * @param {object} input.paths store paths (for snapshots)
 * @param {string} input.file absolute rule-file path
 * @param {{id: string, text: string}[]} input.rules rules the block should contain
 * @param {string} input.reason short reason recorded in the snapshot
 * @returns {{changed: boolean, snapshot: string|null, file: string, content: string}}
 */
export function applyRules({ paths, file, rules, reason }) {
  const before = readTextFile(file);
  const after = writeBlock(before, rules);
  if (after === before) return { changed: false, snapshot: null, file, content: before };
  try {
    const parent = dirname(file);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  } catch { /* the write below reports the real failure */ }
  const snapshot = snapshotFile(paths, { file, content: before, reason });
  atomicWrite(file, after);
  return { changed: true, snapshot, file, content: after };
}
