/**
 * Test helpers shared by the suite.
 *
 * Scratch directories live inside the repository (`test/.scratch`, gitignored)
 * instead of the system temp directory: the harness sandbox does not always grant
 * writes outside the workspace, and a test suite that fails on an unrelated ACL is
 * worse than useless.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Create a fresh scratch directory under `test/.scratch`.
 *
 * @param {string} prefix
 * @returns {string} absolute path
 */
export function scratchDir(prefix = 'scratch-') {
  const root = join(here, '.scratch');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}
