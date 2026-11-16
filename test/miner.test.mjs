import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { acceptCandidate, buildView, ingest, rejectCandidate, revokeRule } from '../src/miner.mjs';
import { normalizeConfig } from '../src/schema.mjs';
import { ensureStore, resolvePaths } from '../src/store.mjs';
import { scratchDir } from './helpers.mjs';

function setup() {
  const root = scratchDir('habit-miner-');
  const workspace = join(root, 'ws');
  const paths = resolvePaths({ storeDir: join(root, 'store') });
  ensureStore(paths);
  const config = normalizeConfig({ scopeDefault: 'workspace', minSessions: 2, minSupport: 2 });
  return { root, workspace, paths, config };
}

function feed(env, text, sessionId) {
  return ingest(env.paths, env.config, {
    userText: text,
    assistantText: '好的，我用 npm 装。',
    sessionId,
    workspace: env.workspace,
    at: new Date().toISOString(),
    channel: 'live',
  });
}

test('one session only observes; the second promotes to pending', () => {
  const env = setup();
  const first = feed(env, '以后都用 pnpm 装依赖', 's1');
  assert.equal(first.result, 'new');
  assert.equal(first.candidate.status, 'observing');

  const second = feed(env, '以后统一用 pnpm 安装依赖', 's2');
  assert.equal(second.result, 'merged');
  assert.equal(second.candidate.status, 'pending');

  const view = buildView(env.paths, env.config, { workspaceRoot: env.workspace });
  assert.equal(view.counts.pending, 1);
  assert.equal(view.pending[0].sessions, 2);
});

test('accept writes the rule file and marks it applied', () => {
  const env = setup();
  feed(env, '以后都用 pnpm 装依赖', 's1');
  feed(env, '以后统一用 pnpm 安装依赖', 's2');
  const id = buildView(env.paths, env.config, { workspaceRoot: env.workspace }).pending[0].id;

  const accepted = acceptCandidate(env.paths, env.config, { id, scope: 'workspace', workspace: env.workspace });
  assert.equal(accepted.ok, true);
  const file = join(env.workspace, 'AGENTS.md');
  assert.ok(readFileSync(file, 'utf8').includes('pnpm'));

  const after = buildView(env.paths, env.config, { workspaceRoot: env.workspace });
  assert.equal(after.counts.accepted, 1);
  assert.equal(after.counts.pending, 0);

  assert.equal(revokeRule(env.paths, { id }).ok, true);
  assert.ok(!readFileSync(file, 'utf8').includes('pnpm'));
});

test('a rejected candidate is suppressed instead of re-queued', () => {
  const env = setup();
  feed(env, '以后都用 pnpm 装依赖', 's1');
  feed(env, '以后统一用 pnpm 安装依赖', 's2');
  const id = buildView(env.paths, env.config, { workspaceRoot: env.workspace }).pending[0].id;
  assert.equal(rejectCandidate(env.paths, { id }).ok, true);

  const again = feed(env, '以后都用 pnpm 装依赖', 's3');
  assert.equal(again.result, 'suppressed');
  assert.equal(buildView(env.paths, env.config, {}).counts.pending, 0);
});

test('an applied rule absorbs repeats instead of queueing them', () => {
  const env = setup();
  feed(env, '以后都用 pnpm 装依赖', 's1');
  feed(env, '以后统一用 pnpm 安装依赖', 's2');
  const id = buildView(env.paths, env.config, { workspaceRoot: env.workspace }).pending[0].id;
  acceptCandidate(env.paths, env.config, { id, scope: 'workspace', workspace: env.workspace });

  const repeat = feed(env, '以后都用 pnpm 装依赖', 's4');
  assert.equal(repeat.result, 'duplicate');
  assert.equal(buildView(env.paths, env.config, {}).counts.pending, 0);
});

test('non-corrections are ignored', () => {
  const env = setup();
  assert.equal(feed(env, '帮我看看这个报错', 's1').result, 'ignored');
  assert.equal(buildView(env.paths, env.config, {}).counts.pending, 0);
});
