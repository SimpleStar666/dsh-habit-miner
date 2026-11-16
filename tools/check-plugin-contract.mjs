/**
 * Distribution contract check: the things a bundle must satisfy before a profile
 * can load it, where a mistake is silent rather than loud.
 *
 * Run with `node tools/check-plugin-contract.mjs`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const checks = [];

/**
 * Record one check.
 *
 * @param {string} label
 * @param {() => void | Promise<void>} body
 * @returns {Promise<void>}
 */
async function check(label, body) {
  try {
    await body();
    checks.push(`ok   ${label}`);
  } catch (error) {
    problems.push(`FAIL ${label}: ${error.message}`);
  }
}

const read = (relative) => readFileSync(join(root, relative), 'utf8');
const pkg = JSON.parse(read('package.json'));

await check('manifest declares a bundle patch', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
});

await check('manifest declares the browser half', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh?.client?.immediately, true);
});

await check('patch inserts one row named after the package', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /- insert:/);
  assert.match(patch, new RegExp(`name: '?${pkg.name}'?`));
  assert.match(patch, /id: dsh-habit-miner/);
});

await check('runtime entry points exist and match exports', () => {
  assert.ok(existsSync(join(root, pkg.main)), `main ${pkg.main} missing`);
  assert.equal(pkg.exports['./client'], './client.js');
  assert.ok(existsSync(join(root, './client.js')));
});

await check('the browser bundle is registered under the package name', () => {
  const client = read('client.js');
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(client, new RegExp(`id: '${pkg.name}'`));
  assert.match(client, /function apply\(ctx\)/);
});

await check('locales carry title, description and detail', () => {
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(read(`locale/${locale}.json`));
    assert.ok(dict.meta?.title, `${locale} title`);
    assert.ok(dict.meta?.description, `${locale} description`);
    assert.ok(dict.meta?.detail, `${locale} detail`);
    assert.ok(existsSync(join(root, dict.meta.detail)), `${locale} detail file`);
    assert.ok(dict.meta.description.length <= 300, `${locale} description too long`);
  }
});

await check('the icon is a small SVG inside the package', () => {
  const icon = read('icon.svg');
  assert.ok(statSync(join(root, 'icon.svg')).size <= 256 * 1024);
  assert.match(icon, /<svg[\s>]/);
  assert.ok(!icon.includes('http://') || !icon.includes('href="http'));
});

await check('the host half only imports node builtins and local modules', () => {
  const files = ['src/plugin.mjs', 'src/store.mjs', 'src/miner.mjs', 'src/scan.mjs', 'src/http.mjs', 'src/tools.mjs', 'src/compile.mjs', 'src/schema.mjs', 'src/targets.mjs', 'src/text.mjs', 'src/similar.mjs', 'src/candidates.mjs'];
  for (const file of files) {
    const body = read(file);
    for (const match of body.matchAll(/from '([^']+)'/g)) {
      const specifier = match[1];
      const allowed = specifier.startsWith('./') || specifier.startsWith('node:');
      assert.ok(allowed, `${file} imports ${specifier}`);
    }
  }
});

await check('no runtime dependency is declared', () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.optionalDependencies ?? {}, {});
});

await check('exports cover locale, icon and client', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
});

await check('the plugin exports the contract shape', async () => {
  const module = await import(pathToFileURL(join(root, 'index.js')).href);
  assert.equal(module.name, 'dsh-habit-miner');
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject));
  assert.ok(module.Config && module.Config['~standard']);
});

for (const line of checks) console.log(line);
if (problems.length) {
  for (const line of problems) console.error(line);
  process.exitCode = 1;
} else {
  console.log(`\n${checks.length} checks passed`);
}
