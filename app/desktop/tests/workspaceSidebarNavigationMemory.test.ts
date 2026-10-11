import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readSource = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('navigation rail forwards the account memory version to the profile control', () => {
  const navigation = readSource('src/pages/workspaceSidebar.navigation.tsx');
  const profileControl = navigation.slice(navigation.indexOf('<SidebarProfileControl'));
  const props = profileControl.slice(0, profileControl.indexOf('/>'));
  assert.match(props, /cloudMemoryVersion=\{account\.cloudMemoryVersion\}/);
});
