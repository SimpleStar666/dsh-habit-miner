import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BLOCK_BEGIN,
  BLOCK_END,
  applyRules,
  readBlock,
  renderBlock,
  workspaceAgentsPath,
  writeBlock,
} from '../src/targets.mjs';
import { ensureStore, resolvePaths } from '../src/store.mjs';
import { scratchDir } from './helpers.mjs';

function tempPaths() {
  const dir = scratchDir('habit-targets-');
  const paths = resolvePaths({ storeDir: join(dir, 'store') });
  ensureStore(paths);
  return { dir, paths };
}

test('renderBlock round-trips through readBlock', () => {
  const block = renderBlock([{ id: 'hab-1', text: '以后都用 pnpm' }, { id: 'hab-2', text: '不要自动提交' }]);
  assert.ok(block.startsWith(BLOCK_BEGIN));
  assert.ok(block.endsWith(BLOCK_END));
  const parsed = readBlock(block);
  assert.deepEqual(parsed.rules, [
    { id: 'hab-1', text: '以后都用 pnpm' },
    { id: 'hab-2', text: '不要自动提交' },
  ]);
});

test('writeBlock preserves the surrounding user content', () => {
  const original = '# 我的规则\n\n- 自己的规则一\n';
  const withBlock = writeBlock(original, [{ id: 'hab-1', text: '以后都用 pnpm' }]);
  assert.ok(withBlock.includes('- 自己的规则一'));
  assert.ok(withBlock.includes('- 以后都用 pnpm'));
  const withoutBlock = writeBlock(withBlock, []);
  assert.ok(!withoutBlock.includes(BLOCK_BEGIN));
  assert.ok(withoutBlock.includes('- 自己的规则一'));
});

test('applyRules snapshots before writing and keeps the file readable', () => {
  const { dir, paths } = tempPaths();
  const file = join(dir, 'AGENTS.md');
  const first = applyRules({ paths, file, rules: [{ id: 'hab-1', text: '以后都用 pnpm' }], reason: 'test' });
  assert.equal(first.changed, true);
  assert.ok(first.snapshot);
  assert.ok(readFileSync(file, 'utf8').includes('以后都用 pnpm'));
  const second = applyRules({ paths, file, rules: [], reason: 'test-remove' });
  assert.equal(second.changed, true);
  assert.ok(!readFileSync(file, 'utf8').includes('以后都用 pnpm'));
  assert.equal(workspaceAgentsPath(dir), join(dir, 'AGENTS.md'));
});
