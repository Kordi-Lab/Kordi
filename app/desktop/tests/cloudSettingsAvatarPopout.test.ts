import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldRefreshCloudContactsForWsSubject } from '../src/features/cloud/useCloudContacts';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('cloud avatar opens a centered account settings modal', () => {
  const sidebar = readSource('pages/WorkspaceSidebar.tsx');
  const slot = readSource('app/assembleSidebarSlot.tsx');
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(sidebar, /CloudAccountSettingsDialog/);
  assert.match(sidebar, /cloudSettings && cloudAccount && onUpdateCloudProfile \? \(/);
  assert.match(slot, /cloudSettings=\{isCloud \? \{/);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-label="Account settings"/);
  assert.match(modal, /fixed inset-0/);
  assert.match(modal, /items-center justify-center/);
});

test('cloud settings modal contains profile authentication and theme sections', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(modal, /Profile/);
  assert.match(modal, /Authentication/);
  assert.match(modal, /Theme/);
  assert.match(modal, /AuthPage/);
  assert.match(modal, /SettingsValueControl/);
  assert.match(modal, /fileToAvatarDataUrl/);
  assert.match(modal, /onUpdateProfile\(\{/);
});

test('cloud contact websocket refreshes when a contact profile changes', () => {
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.profile.updated.acct_peer'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.signed_up.acct_peer'), false);
});
