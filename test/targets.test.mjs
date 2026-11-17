import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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

test('replacement preserves every surrounding UTF-8 byte, including BOM, CRLF and whitespace', () => {
  const rules = [{ id: 'hab-new', text: '保留用户规则' }];
  const oldBlock = renderBlock([{ id: 'hab-old', text: '旧规则' }]).replace(/\n/g, '\r\n');
  const newBlock = renderBlock(rules).replace(/\n/g, '\r\n');
  const head = '\uFEFF  # 我的规则  \r\n\r\n\r\n\r\n\t \r\n   ';
  const tail = '  \t\r\n\r\n\r\n\r\n- 后续规则 🐱  \r\n\r\n  \t';
  const original = head + oldBlock + tail;
  const actual = writeBlock(original, rules);
  assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(head + newBlock + tail, 'utf8'));
  assert.equal(writeBlock(actual, rules), actual, 'replacement must be idempotent');
});

test('replacement does not add separators around an inline managed block', () => {
  const block = renderBlock([{ id: 'hab-1', text: '规则' }]);
  const original = `prefix ${block}\tsuffix`;
  assert.equal(writeBlock(original, [{ id: 'hab-2', text: '新规则' }]),
    `prefix ${renderBlock([{ id: 'hab-2', text: '新规则' }])}\tsuffix`);
});

test('deletion removes only the marker span, leaving all surrounding bytes untouched', () => {
  const block = renderBlock([{ id: 'hab-old', text: '旧规则' }]).replace(/\n/g, '\r\n');
  const head = '\uFEFF\r\n\r\n\r\n  \t';
  const tail = '\t \r\n\r\n\r\n\r\n# 用户规则  \r\n  ';
  const removed = writeBlock(head + block + tail, []);
  assert.deepEqual(Buffer.from(removed, 'utf8'), Buffer.from(head + tail, 'utf8'));
  assert.equal(writeBlock(removed, []), removed, 'deletion must be idempotent');
  assert.equal(writeBlock(block, []), '');
  assert.equal(writeBlock(`\uFEFF${block}`, []), '\uFEFF');
});

test('append keeps the original prefix and adds only the needed paragraph separator', () => {
  const rules = [{ id: 'hab-1', text: '新增规则' }];
  const cases = [
    { text: '', separator: '', newline: '\n' },
    { text: '\uFEFF', separator: '', newline: '\n' },
    { text: 'user  ', separator: '\n\n', newline: '\n' },
    { text: 'user\n', separator: '\n', newline: '\n' },
    { text: 'user\n\n', separator: '', newline: '\n' },
    { text: 'user\n\n\n\n', separator: '', newline: '\n' },
    { text: 'user\n\n  \t', separator: '\n', newline: '\n' },
    { text: '\uFEFF  # 用户规则\r\n\r\n\r\n\r\n', separator: '', newline: '\r\n' },
    { text: '\uFEFF  # 用户规则\r\n\t  ', separator: '\r\n', newline: '\r\n' },
    { text: '\uFEFF  # 用户规则\r\n后续规则  ', separator: '\r\n\r\n', newline: '\r\n' },
    { text: ' \t\r\n\r\n\r\n  ', separator: '\r\n', newline: '\r\n' },
  ];
  for (const { text, separator, newline } of cases) {
    const block = renderBlock(rules).replace(/\n/g, newline);
    const actual = writeBlock(text, rules);
    assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(text + separator + block + newline, 'utf8'));
    assert.equal(writeBlock(actual, rules), actual, `append must be idempotent for ${JSON.stringify(text)}`);
    assert.equal(writeBlock(actual, []), text + separator + newline,
      'deletion must not consume separators outside the marker span');
    assert.equal(writeBlock(text, []), text, 'no managed block and no rules is a byte-preserving no-op');
  }
});

test('writeBlock fails closed for missing, reversed, duplicate and nested markers', () => {
  const block = renderBlock([{ id: 'hab-old', text: '旧规则' }]);
  const broken = [
    BLOCK_BEGIN,
    BLOCK_END,
    `${BLOCK_END}\r\n${BLOCK_BEGIN}`,
    `${BLOCK_BEGIN}\n${BLOCK_BEGIN}\n${BLOCK_END}`,
    `${BLOCK_BEGIN}\n${BLOCK_END}\n${BLOCK_END}`,
    `${block}\n\n${block}`,
    `${block}\n${BLOCK_BEGIN}`,
    `${BLOCK_END}\n${block}`,
    `${BLOCK_BEGIN}\n${BLOCK_BEGIN}\n${BLOCK_END}\n${BLOCK_END}`,
  ];
  for (const text of broken) {
    for (const rules of [[], [{ id: 'hab-new', text: '新规则' }]]) {
      assert.throws(() => writeBlock(`\uFEFF \r\n${text}\r\n  `, rules),
        /Invalid habit-miner managed block markers/);
    }
  }
});

test('applyRules persists exact UTF-8 bytes and recognizes an identical replacement as a no-op', () => {
  const { dir, paths } = tempPaths();
  const file = join(dir, 'AGENTS.md');
  const head = '\uFEFF# 用户规则  \r\n\r\n\r\n \t';
  const tail = '  \r\n\r\n\r\n后续规则 \r\n \t';
  const oldBlock = renderBlock([{ id: 'hab-old', text: '旧规则' }]).replace(/\n/g, '\r\n');
  writeFileSync(file, head + oldBlock + tail, 'utf8');
  const rules = [{ id: 'hab-new', text: '新规则' }];
  const changed = applyRules({ paths, file, rules, reason: 'replace' });
  const expected = head + renderBlock(rules).replace(/\n/g, '\r\n') + tail;
  assert.equal(changed.changed, true);
  assert.deepEqual(readFileSync(file), Buffer.from(expected, 'utf8'));
  const unchanged = applyRules({ paths, file, rules, reason: 'identical' });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.snapshot, null);
  applyRules({ paths, file, rules: [], reason: 'remove' });
  assert.deepEqual(readFileSync(file), Buffer.from(head + tail, 'utf8'));
});

test('applyRules leaves a malformed file untouched rather than appending or deleting', () => {
  const { dir, paths } = tempPaths();
  const file = join(dir, 'AGENTS.md');
  const original = `\uFEFF# 用户规则\r\n\r\n${BLOCK_BEGIN}\r\nmissing end  `;
  writeFileSync(file, original, 'utf8');
  for (const rules of [[], [{ id: 'hab-new', text: '新规则' }]]) {
    assert.throws(() => applyRules({ paths, file, rules, reason: 'broken' }),
      /Invalid habit-miner managed block markers/);
    assert.deepEqual(readFileSync(file), Buffer.from(original, 'utf8'));
  }
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
