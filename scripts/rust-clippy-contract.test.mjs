import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localCommand = 'cargo clippy --workspace --all-targets -- -D warnings';
const portableCiCommand = 'cargo clippy --workspace --exclude kordi-desktop --all-targets -- -D warnings';
const desktopCiCommand = 'cargo clippy -p kordi-desktop --all-targets -- -D warnings';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('local and CI Rust lint gates reject every warning', () => {
  const packageJson = JSON.parse(read('package.json'));
  const workflow = read('.github/workflows/ci.yml');
  const pullRequestTemplate = read('.github/pull_request_template.md');

  assert.match(packageJson.scripts['check:rust:clippy'], new RegExp(localCommand));
  assert.match(workflow, new RegExp(portableCiCommand));
  assert.match(workflow, new RegExp(desktopCiCommand));
  assert.match(pullRequestTemplate, new RegExp(localCommand));

  for (const content of [
    packageJson.scripts['check:rust:clippy'],
    workflow,
    pullRequestTemplate,
  ]) {
    assert.doesNotMatch(content, /-A clippy::never_loop/);
  }
});
