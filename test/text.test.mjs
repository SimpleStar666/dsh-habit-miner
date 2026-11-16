import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifySignal, draftRule, normalizeText, pickRuleClause, stripLeadFillers } from '../src/text.mjs';

test('normalizeText drops punctuation, case and spaces', () => {
  assert.equal(normalizeText('  以后 都用 Pnpm！'), '以后都用pnpm');
});

test('stripLeadFillers removes chained chat lead-ins', () => {
  assert.equal(stripLeadFillers('那麻烦你以后别用 npm'), '别用 npm');
});

test('classifySignal separates durable rules from one-off corrections', () => {
  assert.equal(classifySignal('以后都用 pnpm').kind, 'rule');
  assert.equal(classifySignal('以后都用 pnpm').durable, true);
  assert.equal(classifySignal('这里不该用 npm').kind, 'correction');
  assert.equal(classifySignal('这里不该用 npm').negation, true);
  assert.equal(classifySignal('好的谢谢').kind, null);
  assert.equal(classifySignal('帮我看看这个报错').kind, null);
});

test('pickRuleClause prefers the clause that carries the rule', () => {
  assert.equal(pickRuleClause('不对，以后都用 pnpm'), '以后都用 pnpm');
  assert.equal(pickRuleClause('图表放 diagrams/，别放别处'), '别放别处');
});

test('draftRule turns corrections into short imperatives', () => {
  assert.equal(draftRule('以后图表都放 diagrams/'), '以后图表都放 diagrams/');
  assert.equal(draftRule('那麻烦你别再问我要不要重启'), '别再问我要不要重启');
  assert.equal(draftRule('好的谢谢'), '');
  assert.equal(draftRule('不要'), '');
});

test('draftRule caps very long rules', () => {
  const long = `以后每次${'很长的要求'.repeat(60)}`;
  const draft = draftRule(long);
  assert.ok(draft.length <= 120, `draft length ${draft.length}`);
});

test('task requests, self-descriptions and complaints are not habits', () => {
  assert.equal(classifySignal('那帮我把这个插件安装好，说不定以后我还要用来干别的').kind, null);
  assert.equal(classifySignal('我1999年出生，老家在湖北，现在在深圳工作，以后打算从事音视频领域').kind, null);
  assert.equal(classifySignal('每次说什么那么奇怪的名字 archify 好麻烦').kind, null);
  assert.equal(classifySignal('以后都用 npm').kind, 'rule');
  assert.equal(classifySignal('以后别用 npm 装依赖').kind, 'rule');
});

test('a complaint with its own fix still becomes a rule', () => {
  assert.equal(draftRule('不对，应该用 pnpm 装依赖'), '应该用 pnpm 装依赖');
});
test('a one-off task after a colon does not become part of the rule', () => {
  assert.equal(draftRule('直接回答，不要解释：1+1 等于几？只给数字。'), '不要解释');
  assert.equal(draftRule('以后路径都放 D:\\code 下'), '以后路径都放 D:\\code 下');
});