import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hamming, jaccard, nearDuplicate, simhash, tokenize } from '../src/similar.mjs';

test('tokenize produces CJK bigrams and latin words', () => {
  const tokens = tokenize('以后都用 pnpm 2.0');
  assert.ok(tokens.includes('以后'));
  assert.ok(tokens.includes('pnpm'));
});

test('simhash is stable and 16 hex characters', () => {
  const first = simhash('以后都用 pnpm');
  assert.equal(first, simhash('以后都用 pnpm'));
  assert.match(first, /^[0-9a-f]{16}$/);
});

test('hamming treats a missing fingerprint as unrelated', () => {
  assert.equal(hamming('', 'aaaaaaaaaaaaaaaa'), 64);
  assert.equal(hamming(simhash('abc'), simhash('abc')), 0);
});

test('nearDuplicate merges reworded corrections about the same habit', () => {
  assert.ok(nearDuplicate('以后都用 pnpm 装依赖', '以后统一用 pnpm 安装依赖'));
  assert.ok(nearDuplicate('图表都放 diagrams/ 目录', '以后图表放 diagrams/'));
});

test('nearDuplicate keeps different habits apart', () => {
  assert.ok(!nearDuplicate('以后都用 pnpm', '提交信息用中文写'));
  assert.ok(!nearDuplicate('不要问我要不要重启', '回复里别加表情'));
});

test('jaccard is 1 for identical text and 0 for disjoint', () => {
  assert.equal(jaccard('用 pnpm 装依赖', '用 pnpm 装依赖'), 1);
  assert.equal(jaccard('用 pnpm 装依赖', 'hello world'), 0);
});
