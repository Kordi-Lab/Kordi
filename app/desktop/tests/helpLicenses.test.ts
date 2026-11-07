import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { devLicensesPlugin, ensureDevLicenses } from '../scripts/dev-licenses.mjs';
import { LICENSES_PAGE_TITLE, isLicensesDocument } from '../src/features/onboarding/helpContent';

const quiet = { warn: () => undefined };

function outputDirectory(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'kordi-dev-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'licenses');
}

test('the licenses frame accepts only the staged licenses page', () => {
  assert.equal(isLicensesDocument({ title: LICENSES_PAGE_TITLE }), true);
  assert.equal(isLicensesDocument({ title: 'Kordi' }), false);
  assert.equal(isLicensesDocument({ title: '' }), false);
  // A document the app cannot read is left as loaded.
  assert.equal(isLicensesDocument(null), true);
});

test('dev servers stage the licenses page once and restage it when stale', (t) => {
  const output = outputDirectory(t);
  assert.equal(ensureDevLicenses(output, { log: quiet }), 'staged');
  const page = readFileSync(join(output, 'index.html'), 'utf8');
  assert.match(page, new RegExp(`<title>${LICENSES_PAGE_TITLE}</title>`));
  assert.equal(ensureDevLicenses(output, { log: quiet }), 'current');
  writeFileSync(join(output, 'index.html'), '<!doctype html><title>Kordi</title>');
  assert.equal(ensureDevLicenses(output, { log: quiet }), 'staged');
});

test('a broken license catalog warns instead of stopping the dev server', (t) => {
  const output = outputDirectory(t);
  const warnings: string[] = [];
  const result = ensureDevLicenses(output, { directory: join(output, 'missing-root'), log: { warn: (line: string) => warnings.push(line) } });
  assert.equal(result, 'unavailable');
  assert.equal(warnings.length, 1);
});

test('the staging plugin runs only for the dev server', () => {
  const plugin = devLicensesPlugin();
  assert.equal(plugin.apply, 'serve');
  assert.equal(typeof plugin.configResolved, 'function');
});
