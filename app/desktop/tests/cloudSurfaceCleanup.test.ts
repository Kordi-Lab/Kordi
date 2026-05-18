import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { navItemsForEdition, normalizeNavIdForEdition } from '../src/kordi-app/data/navigation';
import { normalizeSettingsSectionIdForEdition, settingsSectionsForEdition } from '../src/kordi-app/data/settings';

test('cloud navigation hides projects and redirects stale project nav to chats', () => {
  assert.deepEqual(navItemsForEdition('cloud').map((item) => item.id), ['chats', 'contacts', 'agents', 'settings']);
  assert.equal(normalizeNavIdForEdition('cloud', 'projects'), 'chats');
  assert.equal(normalizeNavIdForEdition('local', 'projects'), 'projects');
});

test('cloud settings only exposes authentication and theme', () => {
  const cloudSections = settingsSectionsForEdition('cloud');

  assert.deepEqual(cloudSections.map((section) => section.id), ['auth', 'appearance']);
  assert.deepEqual(cloudSections.map((section) => section.label), ['Authentication', 'Theme']);
  assert.deepEqual(cloudSections[1]?.items.map((item) => item.label), ['Theme']);
  assert.equal(normalizeSettingsSectionIdForEdition('cloud', 'general'), 'auth');
  assert.equal(normalizeSettingsSectionIdForEdition('cloud', 'appearance'), 'appearance');
});

test('app model wires cloud surface cleanup into shell state', () => {
  const source = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');

  assert.match(source, /settingsSectionsForEdition/);
  assert.match(source, /normalizeNavIdForEdition/);
  assert.match(source, /normalizeSettingsSectionIdForEdition/);
  assert.match(source, /visibleSettingsSections/);
});

test('cloud sidebar removes the global plus launcher', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /showSidebarCreateButton\s*=\s*currentKordiEdition\(\) !== 'cloud'/);
  assert.match(source, /showSidebarCreateButton \? \(/);
});
