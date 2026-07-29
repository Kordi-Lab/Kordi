import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const repoUrl = (path) => new URL(`../${path}`, import.meta.url);
const readText = (path) => readFileSync(repoUrl(path), 'utf8');

test('the Rust protocol crate is the app-server protocol source of truth', () => {
  const rootCargo = readText('Cargo.toml');
  const serverCargo = readText('app/server/Cargo.toml');

  assert.match(rootCargo, /"shared\/rust\/protocol"/);
  assert.match(
    rootCargo,
    /kordi-protocol\s*=\s*\{[^}]*path\s*=\s*"shared\/rust\/protocol"[^}]*\}/,
  );
  assert.match(serverCargo, /kordi-protocol\.workspace\s*=\s*true/);
  assert.ok(existsSync(repoUrl('shared/rust/protocol/src/lib.rs')));
});

test('workspace setup cannot recreate the removed TypeScript protocol mirror', () => {
  const rootWorkspace = readText('pnpm-workspace.yaml');
  const workspaceTemplate = readText('app/desktop/templates/monorepo/pnpm-workspace.yaml');
  const adoptionScript = readText('app/desktop/scripts/monorepo/adopt-root-workspace.sh');
  const lockfile = readText('pnpm-lock.yaml');

  assert.equal(existsSync(repoUrl('shared/typescript/protocol/package.json')), false);
  assert.equal(existsSync(repoUrl('shared/typescript/protocol/src/index.ts')), false);
  for (const content of [rootWorkspace, workspaceTemplate, adoptionScript, lockfile]) {
    assert.doesNotMatch(content, /shared\/typescript\/protocol|@kordi\/protocol/);
  }
});
