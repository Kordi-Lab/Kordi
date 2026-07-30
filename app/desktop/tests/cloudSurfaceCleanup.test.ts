import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { navItems, normalizeNavIdForCloud } from '../src/kordi-app/data/navigation';
import { normalizeSettingsSectionIdForCloud, settingsSections } from '../src/kordi-app/data/settings';

test('product navigation only exposes final Cloud pages', () => {
  assert.deepEqual(navItems.map((item) => item.id), ['chats', 'contacts', 'agents']);
  assert.equal(normalizeNavIdForCloud('projects'), 'chats');
  assert.equal(normalizeNavIdForCloud('settings'), 'chats');
  assert.equal(normalizeNavIdForCloud('bridge'), 'chats');
});

test('settings data keeps only final Cloud settings sections', () => {
  assert.deepEqual(settingsSections.map((section) => section.id), ['auth', 'appearance']);
  assert.deepEqual(settingsSections.map((section) => section.label), ['Authentication', 'Theme']);
  assert.deepEqual(settingsSections[1]?.items.map((item) => item.label), ['Theme']);
  assert.equal(normalizeSettingsSectionIdForCloud('general'), 'auth');
  assert.equal(normalizeSettingsSectionIdForCloud('appearance'), 'appearance');
});

test('app model uses Cloud-only surface selectors', () => {
  const appModelSource = readFileSync(
    new URL('../src/app/useKordiAppModel.ts', import.meta.url),
    'utf8',
  );
  const authNavigationSource = readFileSync(
    new URL('../src/app/useKordiAuthNavigationState.ts', import.meta.url),
    'utf8',
  );
  const source = `${appModelSource}\n${authNavigationSource}`;

  assert.doesNotMatch(source, /settingsSectionsForEdition/);
  assert.doesNotMatch(source, /normalizeNavIdForEdition/);
  assert.doesNotMatch(source, /normalizeSettingsSectionIdForEdition/);
  assert.match(appModelSource, /useKordiAuthNavigationState/);
  assert.match(authNavigationSource, /settingsSections/);
  assert.match(authNavigationSource, /normalizeNavIdForCloud/);
  assert.match(authNavigationSource, /normalizeSettingsSectionIdForCloud/);
});

test('final Cloud app does not route to hidden legacy product pages', () => {
  const mainContentSource = readFileSync(new URL('../src/app/MainContentSwitch.tsx', import.meta.url), 'utf8');
  const navigationSource = readFileSync(new URL('../src/kordi-app/data/navigation.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(mainContentSource, /BridgeConfigPage|ProjectsPage|SettingsPage/);
  assert.doesNotMatch(mainContentSource, /case 'bridge'|case 'projects'|case 'settings'/);
  assert.doesNotMatch(navigationSource, /id: 'bridge'|id: 'projects'|id: 'settings'/);
});

test('cloud sidebar removes the global plus launcher entirely', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /showSidebarCreateButton/);
  assert.doesNotMatch(source, /currentKordiEdition/);
});

test('cloud profile menu avoids Cloud and Bridge jargon in visible copy', () => {
  const source = readFileSync(new URL('../src/pages/workspaceSidebar.profile.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, />Cloud<\/span>/);
  assert.doesNotMatch(source, /Cloud account/);
  assert.doesNotMatch(source, /Bridge is syncing missed messages/);
  assert.doesNotMatch(source, /Bridge sync idle/);
  assert.match(source, /aria-label="Logout of account"/);
  assert.doesNotMatch(source, /Session ID: \$\{sessionId\}/);
});

test('cloud chat send errors use user-facing copy', () => {
  const composerSource = readFileSync(new URL('../src/features/chat/useComposerMessageActions.ts', import.meta.url), 'utf8');
  const messageActionSource = readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
  const projectMessageSource = readFileSync(new URL('../src/features/chat/messageActions/projectMessages.ts', import.meta.url), 'utf8');
  const appModelSource = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  const sidebarSlotSource = readFileSync(new URL('../src/app/assembleSidebarSlot.tsx', import.meta.url), 'utf8');
  const combined = `${composerSource}\n${messageActionSource}\n${projectMessageSource}\n${appModelSource}\n${sidebarSlotSource}`;

  assert.doesNotMatch(combined, /Cloud chat is still loading/);
  assert.doesNotMatch(combined, /Cloud group chat is still loading/);
  assert.doesNotMatch(combined, /Unable to resolve Cloud group/);
  assert.doesNotMatch(combined, /Unable to send Cloud group/);
  assert.doesNotMatch(combined, /Localhost Bridge communication was removed from main-cloud/);
  assert.doesNotMatch(combined, /Cloud account is still loading/);
  assert.doesNotMatch(combined, /Cloud account IDs/);
  assert.doesNotMatch(combined, /Cloud session not ready/);
  assert.doesNotMatch(combined, /cloud agent request/);
  assert.doesNotMatch(combined, /bridge outreach/);
  assert.match(combined, /Chat is still loading\. Try again in a moment\./);
});

test('cloud contact and group fallbacks use product-facing names', () => {
  const contactsAdapterSource = readFileSync(new URL('../src/features/cloud/CloudContactsAdapter.tsx', import.meta.url), 'utf8');
  const bridgeStateSource = readFileSync(new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(contactsAdapterSource, /Cloud account IDs/);
  assert.match(contactsAdapterSource, /Account IDs start with/);
  assert.doesNotMatch(bridgeStateSource, /'Cloud group'/);
  assert.doesNotMatch(bridgeStateSource, /Cloud group message failed/);
  assert.doesNotMatch(bridgeStateSource, /cloud agent request/);
});

test('detail section headers use sentence-case styling', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const groupDialogSource = readFileSync(new URL('../src/pages/GroupDetailsDialog.tsx', import.meta.url), 'utf8');
  const contactsPanelSource = readFileSync(new URL('../src/features/cloud/CloudContactsPanel.tsx', import.meta.url), 'utf8');

  const kickerBlock = shellCss.match(/\.app-detail-kicker \{[\s\S]*?\}/)?.[0] ?? '';
  const railKickerBlock = shellCss.match(/\.app-right-detail-rail \.app-detail-kicker \{[\s\S]*?\}/)?.[0] ?? '';

  assert.doesNotMatch(kickerBlock, /text-transform:\s*uppercase/);
  assert.doesNotMatch(kickerBlock, /letter-spacing:\s*0\.(?:1|2)\d*em/);
  assert.doesNotMatch(railKickerBlock, /letter-spacing:\s*0\.(?:1|2)\d*em/);
  assert.doesNotMatch(groupDialogSource, /app-group-management-section-label[^\n]*uppercase tracking-\[0\.14em\]/);
  assert.doesNotMatch(contactsPanelSource, /Your cloud contacts/);
  assert.doesNotMatch(contactsPanelSource, /font-semibold uppercase tracking-\[0\.10em\]/);
  assert.doesNotMatch(groupDialogSource, />\s*People\s*<\/h3>/);
  assert.match(groupDialogSource, /<section aria-label="Group members">/);
  assert.match(contactsPanelSource, /Your contacts/);
});
