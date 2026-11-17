import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileToolDefinition } from '../src/compile.mjs';
import { createToolSpecs } from '../src/tools.mjs';
import { applyAction, buildState } from '../src/http.mjs';
import { buildView, ingest } from '../src/miner.mjs';
import { normalizeConfig } from '../src/schema.mjs';
import { apply, toolAcceptDisabled } from '../src/plugin.mjs';
import { ensureStore, resolvePaths } from '../src/store.mjs';
import { scratchDir } from './helpers.mjs';

const noopApi = {
  scan: async () => ({ ok: true, sessions: 0, events: 0, signals: 0, message: '' }),
  list: () => ({ ok: true, count: 0, items: [], message: '' }),
  accept: () => ({ ok: false, message: '' }),
  reject: () => ({ ok: false, message: '' }),
};

test('every tool compiles to a provider-safe definition', () => {
  for (const spec of createToolSpecs(noopApi)) {
    const definition = compileToolDefinition(spec);
    assert.equal(definition.parameters.type, 'object');
    assert.ok(definition.parameters.properties);
    assert.ok(!Object.hasOwn(definition.parameters, 'required') || Array.isArray(definition.parameters.required));
    assert.ok(definition.output && typeof definition.output.render === 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('tool names are unique and namespaced', () => {
  const names = createToolSpecs(noopApi).map((spec) => spec.name);
  assert.deepEqual([...new Set(names)], names);
  for (const name of names) assert.match(name, /^habit_/);
});

test('model-facing acceptance is disabled by default and opt-in explicitly', () => {
  const refusal = toolAcceptDisabled(normalizeConfig({}));
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /allowToolAccept/);
  assert.equal(toolAcceptDisabled(normalizeConfig({ allowToolAccept: true })), null);
});

test('registered habit_accept refuses writes even if the model supplies consent flags', async () => {
  const definitions = [];
  const storeDir = join(scratchDir('habit-tool-gate-'), 'store');
  const ctx = {
    tools: { register: (definition) => definitions.push(definition) },
    on: () => () => {},
    get: () => null,
  };
  apply(ctx, { storeDir, scanOnFirstRun: false, injectHint: false });
  const accept = definitions.find((definition) => definition.name === 'habit_accept');
  assert.ok(accept);
  const paths = resolvePaths({ storeDir });
  const workspace = join(storeDir, 'workspace');
  const config = normalizeConfig({ scopeDefault: 'workspace' });
  for (const sessionId of ['s1', 's2']) {
    ingest(paths, config, { userText: '以后都用 pnpm 装依赖', sessionId, workspace });
  }
  const id = buildView(paths, config, {}).pending[0].id;
  const result = await accept.execute({ id, scope: 'workspace', workspace, allowToolAccept: true, confirmed: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /习惯面板/);
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
  assert.equal(buildView(paths, config, {}).counts.pending, 1);
  const panel = await applyAction({ paths, config, body: { action: 'accept', id, scope: 'workspace', workspace } });
  assert.equal(panel.body.ok, true);
  assert.equal(existsSync(join(workspace, 'AGENTS.md')), true);
});

test('buildState survives an empty store and reports defaults', () => {
  const root = scratchDir('habit-http-');
  const paths = resolvePaths({ storeDir: join(root, 'store') });
  ensureStore(paths);
  const state = buildState({ paths, config: normalizeConfig({}), context: {} });
  assert.equal(state.ok, true);
  assert.equal(state.counts.pending, 0);
  assert.ok(Array.isArray(state.pending));
  assert.ok(state.agents.global.endsWith('AGENTS.md'));
});
