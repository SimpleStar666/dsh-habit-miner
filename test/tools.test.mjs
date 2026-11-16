import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { compileToolDefinition } from '../src/compile.mjs';
import { createToolSpecs } from '../src/tools.mjs';
import { buildState } from '../src/http.mjs';
import { normalizeConfig } from '../src/schema.mjs';
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
