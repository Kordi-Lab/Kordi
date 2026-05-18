import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldRefreshCloudContactsForWsSubject } from '../src/features/cloud/useCloudContacts';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('cloud avatar opens a small account menu before the centered settings modal', () => {
  const sidebar = readSource('pages/WorkspaceSidebar.tsx');
  const slot = readSource('app/assembleSidebarSlot.tsx');
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(sidebar, /aria-label="Account menu"/);
  assert.match(sidebar, /Open profile settings/);
  assert.match(sidebar, /Open account settings/);
  assert.match(sidebar, /CloudProfileRowCopyButton label=\{row\.label\} value=\{row\.value\}/);
  assert.match(sidebar, /cloudAccountDialogTab !== null/);
  assert.doesNotMatch(sidebar, /isOpen=\{isProfileCardOpen\}/);
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
  assert.match(modal, /initialTab/);
});

test('profile modal is distilled to one avatar and no cloud explanation copy', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');
  const sidebar = readSource('pages/WorkspaceSidebar.tsx');

  assert.equal((modal.match(/<IdentityAvatar/g) ?? []).length, 1);
  assert.doesNotMatch(modal, /Update the name and avatar other Cloud users see/);
  assert.doesNotMatch(modal, /Cloud account/);
  assert.doesNotMatch(modal, /Cloud identity/);
  assert.doesNotMatch(sidebar, />Cloud account</);
});

test('profile sign out action is styled as destructive red', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(modal, /text-rose-200/);
  assert.match(modal, /border-rose-400\/20/);
  assert.match(modal, /hover:bg-rose-500\/15/);
});

test('cloud profile updates publish to observers and the edited account', () => {
  const routes = readFileSync(new URL('../../../bridges/cloud-server/src/auth/routes.rs', import.meta.url), 'utf8');

  assert.match(routes, /observer_account_ids\.insert\(session\.account_id\.clone\(\)\)/);
  assert.match(routes, /for observer_account_id in observer_account_ids/);
});

test('cloud contact websocket refreshes when a contact profile changes', () => {
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.profile.updated.acct_peer'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.signed_up.acct_peer'), false);
});
