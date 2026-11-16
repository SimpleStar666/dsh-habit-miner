/**
 * Near-duplicate detection with no dependencies and no model.
 *
 * The habit miner needs to answer "did the user already say this before?" across
 * sessions. A hosted embedding API is not available on the free channels this
 * plugin targets, so similarity is estimated locally:
 *
 * - **SimHash over character bigrams** for longer sentences: robust to word order,
 *   one flip per differing feature.
 * - **Jaccard over token sets** for short sentences, where a 64-bit fingerprint is
 *   too coarse to separate "用 pnpm" from "不用 pnpm".
 *
 * Both are cheap enough to run on every captured message.
 *
 * @module dsh-habit-miner/similar
 */

import { normalizeText } from './text.mjs';

/** FNV-1a over UTF-16 code units, 32-bit. */
function fnv1a32(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Popcount of a 32-bit integer. */
function popcount32(value) {
  let n = value >>> 0;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

/**
 * Tokenise normalised text into comparable features.
 *
 * CJK runs become character bigrams (single characters when the run is one
 * character); Latin and digit runs become whole words.
 *
 * @param {string} text raw text
 * @returns {string[]} unique features
 */
export function tokenize(text) {
  // Keep word boundaries: the CJK bigram feature and a latin word must not merge.
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：、“”‘’《》（）【】…·—～\s\u3000]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const features = new Set();
  const runs = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[a-z0-9]+/g) ?? [];
  for (const run of runs) {
    if (/^[a-z0-9]+$/.test(run)) {
      features.add(run);
      continue;
    }
    if (run.length === 1) {
      features.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      features.add(run.slice(index, index + 2));
    }
  }
  return [...features];
}

/**
 * 64-bit SimHash over features, as 16 lowercase hex characters.
 *
 * @param {string} text raw text
 * @returns {string} fingerprint; '' for an empty feature set
 */
export function simhash(text) {
  const features = tokenize(text);
  if (features.length === 0) return '';
  const weights = new Array(64).fill(0);
  for (const feature of features) {
    const hi = fnv1a32(`${feature}#a`);
    const lo = fnv1a32(`${feature}#b`, 0x9e3779b9);
    for (let bit = 0; bit < 32; bit += 1) {
      weights[bit] += (hi >>> bit) & 1 ? 1 : -1;
      weights[32 + bit] += (lo >>> bit) & 1 ? 1 : -1;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (weights[bit] > 0) hi = (hi | (1 << bit)) >>> 0;
    if (weights[32 + bit] > 0) lo = (lo | (1 << bit)) >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * Hamming distance between two 64-bit fingerprints.
 *
 * @param {string} a 16-hex fingerprint
 * @param {string} b 16-hex fingerprint
 * @returns {number} 0..64, or 64 when either side is empty (treated as unrelated)
 */
export function hamming(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  const hiA = Number.parseInt(a.slice(0, 8), 16) >>> 0;
  const loA = Number.parseInt(a.slice(8), 16) >>> 0;
  const hiB = Number.parseInt(b.slice(0, 8), 16) >>> 0;
  const loB = Number.parseInt(b.slice(8), 16) >>> 0;
  return popcount32(hiA ^ hiB) + popcount32(loA ^ loB);
}

/**
 * Jaccard similarity between two token sets.
 *
 * @param {string} a raw text
 * @param {string} b raw text
 * @returns {number} 0..1
 */
export function jaccard(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The Latin / digit tokens of a text, which carry identifiers (pnpm, npm, H.264).
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function latinTokens(text) {
  return new Set(tokenize(text).filter((token) => /^[a-z0-9]+$/.test(token)));
}

/**
 * Dice similarity over normalised character unigrams.
 *
 * Reworded corrections ("都用" vs "统一用", "装" vs "安装") keep most characters,
 * so unigrams recover the shared meaning that CJK bigrams lose.
 *
 * @param {string} a raw text
 * @param {string} b raw text
 * @returns {number} 0..1
 */
export function diceUnigrams(a, b) {
  const left = new Set([...normalizeText(a)]);
  const right = new Set([...normalizeText(b)]);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Whether two identifier token sets are compatible: equal, or one side empty.
 * `pnpm` and `npm` must never be treated as the same habit.
 *
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {boolean}
 */
function latinCompatible(left, right) {
  if (left.size === 0 || right.size === 0) return true;
  if (left.size !== right.size) return false;
  for (const token of left) if (!right.has(token)) return false;
  return true;
}

/**
 * Decide whether two texts describe the same habit.
 *
 * Three signals must agree to merge: the identifier tokens, a character-level
 * similarity, and (for longer texts) the SimHash fingerprint.
 *
 * @param {string} a raw text or fingerprint+text pair object
 * @param {string} b raw text
 * @param {{nearDupHamming?: number}} [options]
 * @returns {boolean}
 */
export function nearDuplicate(a, b, options = {}) {
  const threshold = options.nearDupHamming ?? 12;
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return false;
  const normLeft = normalizeText(left);
  const normRight = normalizeText(right);
  if (!normLeft || !normRight) return false;
  if (normLeft === normRight) return true;
  if (!latinCompatible(latinTokens(left), latinTokens(right))) return false;

  const score = Math.max(jaccard(left, right), diceUnigrams(left, right));
  const short = normLeft.length <= 14 || normRight.length <= 14;
  if (short) return score >= 0.6;
  if (score < 0.42) return false;
  return score >= 0.5 || hamming(simhash(left), simhash(right)) <= threshold;
}
