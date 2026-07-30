import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const compositionSource = readFileSync(
  new URL('../src/app/kordiShellComposition.types.ts', import.meta.url),
  'utf8',
);
const shellArgsSource = readFileSync(
  new URL('../src/app/useKordiShellArgs.ts', import.meta.url),
  'utf8',
);

const expectedGroups = [
  'environment',
  'conversationIndex',
  'workspaceDirectory',
  'workspaceActions',
  'contactWorkspace',
  'agentWorkspace',
  'settings',
  'workspacePanels',
  'composerMenus',
  'composerDrafts',
  'composerRuntime',
  'conversationDetail',
  'overlays',
] as const;

function compositionGroups() {
  return [...compositionSource.matchAll(/^ {2}(\w+): ShellArgGroup<([\s\S]*?)^ {2}>;/gm)]
    .map((match) => ({
      name: match[1],
      fields: [...match[2].matchAll(/'([^']+)'/g)].map((fieldMatch) => fieldMatch[1]),
    }));
}

test('shell composition keeps each domain below the 50-field boundary', () => {
  const groups = compositionGroups();

  assert.deepEqual(groups.map(({ name }) => name), expectedGroups);
  for (const group of groups) {
    assert.ok(group.fields.length > 0, `${group.name} must own at least one shell field`);
    assert.ok(
      group.fields.length <= 50,
      `${group.name} owns ${group.fields.length} shell fields; split it before exceeding 50`,
    );
    assert.equal(
      new Set(group.fields).size,
      group.fields.length,
      `${group.name} must not repeat shell fields`,
    );
  }
});

test('shell composition reconstructs every domain through the checked flat contract', () => {
  assert.match(
    shellArgsSource,
    /const args: AssembleKordiShellSlotsArgs = \{/,
    'the compiler-checked flat contract must remain the composition source of truth',
  );
  for (const group of expectedGroups) {
    assert.match(shellArgsSource, new RegExp(`\\.\\.\\.groups\\.${group},`));
  }
});
