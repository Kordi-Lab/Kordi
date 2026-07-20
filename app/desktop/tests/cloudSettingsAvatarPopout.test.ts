import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldRefreshCloudContactsForWsSubject } from '../src/features/cloud/useCloudContacts';
import { cloudProfileSaveInput } from '../src/pages/CloudAccountSettingsDialog';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('cloud avatar opens a small account menu before the centered settings modal', () => {
  const sidebar = readSource('pages/WorkspaceSidebar.tsx');
  const slot = readSource('app/assembleSidebarSlot.tsx');
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(sidebar, /aria-label="Account menu"/);
  assert.doesNotMatch(sidebar, /Open profile settings/);
  assert.match(sidebar, /Open account settings/);
  assert.match(sidebar, /CloudProfileRowCopyButton label="Account ID" value=\{cloudAccount\.accountId\}/);
  assert.match(sidebar, /cloudAccountDialogTab !== null/);
  assert.doesNotMatch(sidebar, /isOpen=\{isProfileCardOpen\}/);
  assert.match(slot, /cloudSettings=\{\{/);
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
  assert.match(modal, /onUpdateProfile\(input\)/);
  assert.match(modal, /initialTab/);
});

test('cloud settings modal uses the flat main-app palette instead of nested transient boards', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');
  const authPage = readSource('kordi-app/auth/AuthPage.tsx');
  const providerList = readSource('kordi-app/auth/AuthProviderList.tsx');
  const shellPages = readSource('styles/shell-pages.css');
  const themeOverrides = readSource('styles/theme-overrides.css');

  assert.match(modal, /app-cloud-account-settings-overlay/);
  assert.match(modal, /app-cloud-account-settings-dialog/);
  assert.match(modal, /app-cloud-account-settings-dialog[^\n]*rounded-\[12px\]/);
  assert.doesNotMatch(modal, /app-cloud-account-settings-dialog[^\n]*rounded-\[18px\]/);
  assert.doesNotMatch(modal, /app-cloud-account-settings-dialog[^\n]*\sborder(?:\s|$)/);
  assert.doesNotMatch(modal, /bg-black\/45/);
  assert.doesNotMatch(`${modal}\n${authPage}`, /rgba\(126,111,64/);
  const modalPaletteBlock = themeOverrides.slice(
    themeOverrides.indexOf('.bridge-app.theme-light .app-auth-settings-page .app-auth-provider-list'),
    themeOverrides.indexOf('.bridge-app.theme-light .app-agent-shell'),
  );

  assert.match(themeOverrides, /\.bridge-app\.theme-light \.app-cloud-account-settings-dialog\s*\{/);
  assert.match(themeOverrides, /\.bridge-app\.theme-light \.app-cloud-account-settings-overlay\s*\{/);
  assert.match(modal, /app-session-panel app-cloud-account-settings-rail/);
  assert.match(modal, /app-main-panel app-cloud-account-settings-page/);
  assert.doesNotMatch(modal, /app-surface-muted rounded-\[24px\]/);
  assert.doesNotMatch(providerList, /app-surface-muted app-auth-provider-list/);
  assert.match(shellPages, /\.app-auth-settings-page \.app-auth-detail-section\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.match(modalPaletteBlock, /\.app-auth-settings-page \.app-auth-detail-section\s*\{[^}]*background:\s*transparent;/s);
  assert.match(modalPaletteBlock, /\.app-cloud-account-settings-overlay\s*\{[^}]*rgb\(15 23 42 \/ 0\.24\)/s);
  assert.match(modalPaletteBlock, /\.app-cloud-account-settings-dialog\s*\{[^}]*border:\s*0[^}]*background:\s*var\(--app-main-bg\)[^}]*box-shadow:\s*0 12px 30px rgb\(15 23 42 \/ 0\.11\)/s);
  assert.match(shellPages, /\.app-transient-surface\.app-cloud-account-settings-dialog\s*\{[^}]*border:\s*0[^}]*box-shadow:\s*0 14px 36px rgb\(0 0 0 \/ 0\.28\)/s);
  assert.doesNotMatch(shellPages, /\.app-cloud-account-profile\s*\{[^}]*border-(?:top|bottom)/s);
  assert.doesNotMatch(modal, /app-cloud-account-theme[^\n]*border-y/);
  assert.match(themeOverrides, /\.bridge-app\.theme-light \.app-auth-provider-glyph[\s\S]*rgba\(239, 246, 255, 0\.96\)/);
  assert.doesNotMatch(modalPaletteBlock, /rgba\(147, 128, 109|rgba\(138, 118, 98|rgba\(126,111,64/);
});

test('cloud authentication tab suppresses nested auth chrome and stays readable', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');
  const authPage = readSource('kordi-app/auth/AuthPage.tsx');
  const providerList = readSource('kordi-app/auth/AuthProviderList.tsx');

  assert.match(modal, /showSettingsHeader=\{false\}/);
  assert.match(modal, /settingsLayoutMode="fluid"/);
  assert.match(modal, /max-w-\[680px\]/);
  assert.doesNotMatch(modal, /Connect Kordi to cloud accounts or local model servers/);
  assert.match(authPage, /showSettingsHeader = true/);
  assert.match(authPage, /settingsLayoutMode = 'fixed'/);
  assert.doesNotMatch(providerList, /Pick a cloud account/);
  assert.match(providerList, /Pick a provider\. One working connection is enough\./);
  assert.match(providerList, /app-auth-provider-rows[^\n]*border-y[^\n]*bg-transparent[^\n]*shadow-none/);
  assert.doesNotMatch(providerList, /app-auth-provider-rows[^\n]*rounded-\[22px\]/);
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

test('account popover keeps account id compact and removes redundant profile row', () => {
  const sidebar = readSource('pages/WorkspaceSidebar.tsx');
  const accountMenuStart = sidebar.indexOf('aria-label="Account menu"');
  const accountMenuEnd = sidebar.indexOf('{!cloudSettings && isProfileCardOpen', accountMenuStart);
  assert.ok(accountMenuStart >= 0 && accountMenuEnd > accountMenuStart, 'cloud account menu block should be present');
  const accountMenu = sidebar.slice(accountMenuStart, accountMenuEnd);

  assert.match(accountMenu, /CloudProfileRowCopyButton label="Account ID" value=\{cloudAccount\.accountId\}/);
  assert.doesNotMatch(accountMenu, /profileRows\.map/);
  assert.doesNotMatch(accountMenu, /Open profile settings/);
  assert.doesNotMatch(accountMenu, />Profile</);
  assert.match(accountMenu, /Open account settings/);
  assert.match(accountMenu, />Settings</);
});

test('profile sign out action is styled as destructive red', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(modal, /text-rose-200/);
  assert.match(modal, /border-rose-400\/20/);
  assert.match(modal, /hover:bg-rose-500\/15/);
});

test('profile save omits an unchanged avatar so legacy or external avatars do not fail validation', () => {
  assert.deepEqual(cloudProfileSaveInput({
    displayNameDraft: 'Renamed user',
    avatarUrlDraft: 'https://images.example/avatar.png',
    originalAvatarUrl: 'https://images.example/avatar.png',
  }), {
    displayName: 'Renamed user',
  });

  assert.deepEqual(cloudProfileSaveInput({
    displayNameDraft: 'Renamed user',
    avatarUrlDraft: 'data:image/jpeg;base64,new',
    originalAvatarUrl: 'https://images.example/avatar.png',
  }), {
    displayName: 'Renamed user',
    avatarUrl: 'data:image/jpeg;base64,new',
  });
});

test('profile editor does not reset avatar drafts while open for same account sync updates', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(modal, /openedAccountIdRef/);
  assert.doesNotMatch(modal, /\}, \[account, initialTab, isOpen, setActiveSettingsSectionId\]\);/);
});

test('cloud profile updates publish to observers and the edited account', () => {
  const routes = readFileSync(new URL('../../../bridges/cloud-server/src/auth/routes.rs', import.meta.url), 'utf8');

  assert.match(routes, /observer_account_ids\.insert\(session\.account_id\.clone\(\)\)/);
  assert.match(routes, /for observer_account_id in observer_account_ids/);
});

test('auth notice opens the cloud account settings authentication panel', () => {
  const chatsPage = readSource('pages/ChatsPage.tsx');
  const builders = readSource('app/mainContentShellBuilders.ts');
  const types = readSource('app/kordiShellSlots.types.ts');

  assert.match(chatsPage, /actionLabel=\{authNoticeActionLabel\}/);
  assert.match(chatsPage, /description=\{authNoticeDescription\}/);
  assert.match(chatsPage, /onAction=\{onOpenAccountAuthentication \?\? onOpenAuthSettings\}/);
  assert.match(builders, /onOpenAccountAuthentication: args\.openCloudAccountAuthentication/);
  assert.match(types, /openCloudAccountAuthentication\?: \(\) => void/);
});

test('cloud contact websocket refreshes when a contact profile changes', () => {
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.profile.updated.acct_peer'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.signed_up.acct_peer'), false);
});
