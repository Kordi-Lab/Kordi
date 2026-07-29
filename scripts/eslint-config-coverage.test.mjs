import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(repoRoot, 'app', 'desktop');
const eslintCli = path.join(desktopRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');

function printedConfig(relativePath) {
  const output = execFileSync(process.execPath, [
    eslintCli,
    '--print-config',
    relativePath,
  ], {
    cwd: desktopRoot,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function severity(config, ruleName) {
  return config.rules?.[ruleName]?.[0];
}

test('production TSX uses typed TypeScript and React Hooks linting', () => {
  const config = printedConfig('src/KordiApp.tsx');

  assert.match(config.languageOptions.parser, /typescript-eslint\/parser/);
  assert.equal(config.languageOptions.parserOptions.projectService, true);
  assert.equal(severity(config, '@typescript-eslint/no-floating-promises'), 2);
  assert.equal(severity(config, '@typescript-eslint/no-unused-vars'), 2);
  assert.equal(severity(config, 'react-hooks/rules-of-hooks'), 2);
  assert.equal(severity(config, 'no-console'), 2);
});

test('TSX tests remain linted without requiring the production project service', () => {
  const config = printedConfig('tests/authModel.test.tsx');

  assert.match(config.languageOptions.parser, /typescript-eslint\/parser/);
  assert.equal(config.languageOptions.parserOptions.projectService, undefined);
  assert.equal(severity(config, '@typescript-eslint/no-unused-vars'), 2);
  assert.equal(severity(config, 'react-hooks/rules-of-hooks'), 2);
  assert.equal(severity(config, 'no-console'), 2);
});
