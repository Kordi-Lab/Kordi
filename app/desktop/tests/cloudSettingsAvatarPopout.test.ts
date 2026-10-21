import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldRefreshCloudContactsForWsSubject } from '../src/features/cloud/useCloudContacts';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { cloudProfileSaveInput } from '../src/pages/CloudAccountSettingsDialog';
import {
  cloudProfileErrorTarget,
  cloudProfileFieldDraft,
  cloudProfileHandleDraft,
  cloudProfileNumberPlaceholder,
  kordiIdLockedUntilLabel,
  sanitizeKordiHandleInput,
} from '../src/pages/cloudProfileDraft';
import { accountPopoverLeft } from '../src/pages/workspaceSidebar.profileModel';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

/** The dialog plus the profile panel and editor state it renders. */
function readProfileDialogSource(): string {
  return ['pages/CloudAccountSettingsDialog.tsx', 'pages/CloudProfilePanel.tsx', 'pages/useCloudProfileEditor.ts']
    .map(readSource)
    .join('\n');
}

test('cloud avatar opens a small account menu before the centered settings modal', () => {
  const profileControl = readSource('pages/workspaceSidebar.profile.tsx');
  const slot = readSource('app/assembleSidebarSlot.tsx');
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(profileControl, /aria-label="Account menu"/);
  assert.doesNotMatch(profileControl, /Open profile settings/);
  assert.match(profileControl, /Open account settings/);
  assert.match(profileControl, /CloudProfileRowCopyButton[\s\S]*label="Kordi ID"[\s\S]*value=\{profileKordiHandle\}[\s\S]*compact/);
  assert.match(profileControl, /isOpen=\{dialogTab !== null\}/);
  assert.doesNotMatch(profileControl, /isOpen=\{isProfileCardOpen\}/);
  assert.match(slot, /cloudSettings:\s*\{/);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-label="Account settings"/);
  assert.match(modal, /fixed inset-0/);
  assert.match(modal, /items-center justify-center/);
});

test('cloud settings modal contains profile authentication and theme sections', () => {
  const modal = readProfileDialogSource() + readSource('pages/cloudAccountSettingsNav.ts');
  const avatarEditor = readSource('kordi-app/components/EditableIdentityAvatar.tsx');

  assert.match(modal, /Profile/);
  assert.match(modal, /Authentication/);
  assert.match(modal, /Appearance/);
  assert.match(modal, /Theme/);
  assert.match(modal, /AuthPage/);
  assert.match(modal, /AppearanceSettingsRow/);
  assert.match(avatarEditor, /fileToAvatarDataUrl/);
  assert.match(modal, /onUpdateProfile\(cloudProfileSaveInput\(/);
  assert.match(modal, /initialTab/);
});

test('cloud settings modal uses the flat main-app palette instead of nested transient boards', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');
  const authPage = readSource('kordi-app/auth/AuthPage.tsx');
  const providerList = readSource('kordi-app/auth/AuthProviderList.tsx');
  const providerGlyph = readSource('kordi-app/auth/AuthProviderGlyph.tsx');
  const shellPages = readDesktopShellCss();
  const themeOverrides = shellPages;

  assert.match(modal, /app-cloud-account-settings-overlay/);
  assert.match(modal, /app-cloud-account-settings-dialog/);
  assert.match(modal, /app-cloud-account-settings-dialog[^\n]*rounded-\[12px\]/);
  assert.doesNotMatch(modal, /app-cloud-account-settings-dialog[^\n]*rounded-\[18px\]/);
  assert.doesNotMatch(modal, /app-cloud-account-settings-dialog[^\n]*\sborder(?:\s|$)/);
  assert.doesNotMatch(modal, /bg-black\/45/);
  assert.doesNotMatch(`${modal}\n${authPage}`, /rgba\(126,111,64/);
  const modalPaletteBlock = themeOverrides.slice(
    themeOverrides.indexOf('.kordi-app.theme-light .app-auth-settings-page .app-auth-provider-list'),
    themeOverrides.indexOf('.kordi-app.theme-light .app-agent-shell'),
  );

  assert.match(themeOverrides, /\.kordi-app\.theme-light \.app-cloud-account-settings-dialog\s*\{/);
  assert.match(themeOverrides, /\.kordi-app\.theme-light \.app-cloud-account-settings-overlay\s*\{/);
  assert.match(modal, /app-cloud-account-settings-rail/);
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
  assert.doesNotMatch(providerGlyph, /bg-\[linear-gradient|rounded-\[14px\] border|shadow-\[inset/);
  assert.match(providerGlyph, /src=\{`\/provider-logos\/\$\{logo\}\.svg`\}/);
  assert.doesNotMatch(themeOverrides, /\.kordi-app\.theme-light \.app-auth-provider-glyph\s*\{[^}]*background:/s);
  assert.doesNotMatch(modalPaletteBlock, /rgba\(147, 128, 109|rgba\(138, 118, 98|rgba\(126,111,64/);
});

test('cloud authentication tab suppresses nested auth chrome and stays readable', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');
  const authPage = readSource('kordi-app/auth/AuthPage.tsx');
  const providerList = readSource('kordi-app/auth/AuthProviderList.tsx');
  const shellPages = readDesktopShellCss();

  assert.match(modal, /showSettingsHeader=\{false\}/);
  assert.match(modal, /settingsLayoutMode="fluid"/);
  assert.match(modal, /max-w-\[680px\]/);
  assert.doesNotMatch(modal, /Connect Kordi to cloud accounts or local model servers/);
  assert.match(authPage, /showSettingsHeader = true/);
  assert.match(authPage, /settingsLayoutMode = 'fixed'/);
  assert.doesNotMatch(providerList, /Pick a cloud account/);
  assert.doesNotMatch(providerList, /Pick a provider\. One working connection is enough\./);
  assert.match(providerList, /aria-label="Search providers"/);
  assert.match(providerList, /app-auth-provider-index-row/);
  assert.match(providerList, /aria-label="Provider index"/);
  assert.doesNotMatch(providerList, /rounded-2xl border border-white\/\[0\.08\]/);
  assert.match(providerList, /rounded-xl border-0 bg-white\/\[0\.045\]/);
  assert.doesNotMatch(providerList, /divide-y|border-b border-white/);
  assert.doesNotMatch(shellPages, /app-auth-provider-count\s*\{[^}]*(?:background|border)/s);
});

test('profile modal is distilled to one avatar and no cloud explanation copy', () => {
  const modal = readProfileDialogSource();
  const profileControl = readSource('pages/workspaceSidebar.profile.tsx');

  assert.equal((modal.match(/<EditableIdentityAvatar/g) ?? []).length, 1);
  assert.doesNotMatch(modal, /Update the name and avatar other Cloud users see/);
  assert.doesNotMatch(modal, /Cloud account/);
  assert.doesNotMatch(modal, /Cloud identity/);
  assert.doesNotMatch(profileControl, />Cloud account</);
});

test('profile editor groups identity controls without resizing the settings dialog', () => {
  const modal = readProfileDialogSource();
  const avatarEditor = readSource('kordi-app/components/EditableIdentityAvatar.tsx');
  const profileCss = readSource('styles/cloud-profile-editor.css');

  assert.match(profileCss, /\.app-cloud-profile-row\s*\{[^}]*grid-template-columns:\s*112px minmax\(0, 1fr\);/s);
  assert.match(modal, /<EditableIdentityAvatar/);
  assert.match(modal, /generatedAvatarPreviewUrl/);
  assert.doesNotMatch(modal, /generatedAvatarMarker/);
  assert.match(avatarEditor, /<Dice5 className="h-3\.5 w-3\.5"/);
  assert.match(avatarEditor, /flex w-7 shrink-0 flex-col overflow-hidden rounded-full/);
  assert.match(modal, /app-cloud-account-settings-dialog[^\n]*h-\[min\(680px,/);
  assert.doesNotMatch(modal, /h-\[min\(440px,|>\s*(?:Upload avatar|Change|Generate another|Use generated)\s*</);
});

test('profile rows use borderless accent values with per-row errors', () => {
  const panel = readSource('pages/CloudProfilePanel.tsx');
  const row = readSource('kordi-app/cloud/CloudProfileFieldRow.tsx');
  const profileCss = readSource('styles/cloud-profile-editor.css');

  for (const label of ['Name', 'Kordi ID', 'About', 'Location', 'Time zone', 'Website', 'Birthday']) {
    assert.match(panel, new RegExp(`["']${label}["']`), label);
  }
  assert.match(panel, /layout="profile"/);
  assert.doesNotMatch(panel, /app-input-shell/);
  assert.match(panel, /<option value="">Automatic<\/option>/);
  assert.match(panel, /type="date"[\s\S]*min=\{BIRTHDAY_MIN\}[\s\S]*max=\{today\}/);
  assert.match(panel, /aria-label="Clear birthday"/);
  assert.match(panel, /disabled=\{editor\.isSaving \|\| !editor\.isDirty\}/);
  assert.doesNotMatch(panel, /Your name and avatar are shown to your contacts/);
  // Email ends the table: the Save row sits outside the divided section, after a 24px gap.
  assert.match(panel, /<\/SettingsSection>\s*\{\/\*[^*]*\*\/\}\s*<div className="app-cloud-profile-save pt-6">\s*<SettingsRow/);
  assert.match(row, /app-error-text app-cloud-profile-row-error/);
  assert.match(profileCss, /\.app-cloud-profile-input\s*\{[^}]*border:\s*0;[^}]*color:\s*var\(--app-palette-accent\);/s);
  assert.match(profileCss, /\.app-cloud-profile-input\[aria-invalid='true'\]\s*\{[^}]*var\(--app-transient-danger-text\)/s);
  assert.match(profileCss, /\.app-cloud-profile-input:disabled\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*cursor:\s*default;/s);
  assert.match(profileCss, /\.app-cloud-profile-row-value:focus-within\s*\{[^}]*outline:\s*2px solid/s);
});

test('account popover shows the public handle directly and copies invites without another card', () => {
  const profileControl = readSource('pages/workspaceSidebar.profile.tsx');
  const accountMenuStart = profileControl.indexOf('aria-label="Account menu"');
  const accountMenuEnd = profileControl.indexOf('{!cloudSettings', accountMenuStart);
  assert.ok(accountMenuStart >= 0 && accountMenuEnd > accountMenuStart, 'cloud account menu block should be present');
  const accountMenu = profileControl.slice(accountMenuStart, accountMenuEnd);

  assert.match(accountMenu, /CloudProfileRowCopyButton[\s\S]*label="Kordi ID"[\s\S]*value=\{profileKordiHandle\}[\s\S]*compact/);
  assert.match(accountMenu, /CloudAppInviteCopyRow onCreateInvite=\{onCreateAppInvite\}/);
  assert.doesNotMatch(accountMenu, /profileRows\.map/);
  assert.doesNotMatch(accountMenu, /cloudAccount\.primaryEmail/);
  assert.doesNotMatch(accountMenu, /cloudAccount\.accountId/);
  assert.doesNotMatch(accountMenu, /Open profile settings/);
  assert.doesNotMatch(accountMenu, />Profile</);
  assert.match(accountMenu, /Open account settings/);
  assert.match(accountMenu, />\s*Settings\s*</);
  assert.doesNotMatch(profileControl, /profileDisplayName[\s\S]{0,160}primaryEmail/);
});

test('account popover variants share compact responsive geometry and shell typography', () => {
  const profileControl = readSource('pages/workspaceSidebar.profile.tsx');
  const shellCss = readDesktopShellCss();

  assert.equal((profileControl.match(/app-profile-popover app-account-popover/g) ?? []).length, 2);
  assert.doesNotMatch(profileControl, /w-\[(?:22rem|21\.25rem)\]/);
  assert.match(shellCss, /\.app-account-popover\s*\{[^}]*width:\s*min\(17\.75rem, calc\(100vw - 1rem\)\);[^}]*font-family:\s*inherit;/s);
  assert.match(shellCss, /\.app-account-popover \.app-transient-identity-title\s*\{[^}]*font-size:\s*0\.8125rem;[^}]*line-height:\s*1\.125rem;/s);
  assert.match(shellCss, /\.app-account-popover \.app-transient-action-row,[^}]*font-size:\s*0\.75rem;[^}]*line-height:\s*1rem;/s);
  assert.match(shellCss, /\.app-account-popover \.app-transient-metadata\s*\{[^}]*font-size:\s*0\.6875rem;[^}]*line-height:\s*0\.9375rem;/s);
  assert.match(profileControl, /grid-cols-\[0\.875rem_minmax\(0,1fr\)_1\.75rem\]/);
});

test('account popover stays within the compact window safe area', () => {
  assert.equal(accountPopoverLeft({
    triggerRight: 54,
    viewportWidth: 1200,
    rootFontSize: 16,
  }), 62);
  assert.equal(accountPopoverLeft({
    triggerRight: 54,
    viewportWidth: 300,
    rootFontSize: 16,
  }), 8);
  assert.equal(accountPopoverLeft({
    triggerRight: 54,
    viewportWidth: 220,
    rootFontSize: 16,
  }), 8);
});

test('profile sign out action is styled as destructive red', () => {
  const modal = readProfileDialogSource();

  assert.match(modal, /text-rose-200/);
  assert.match(modal, /border-rose-400\/20/);
  assert.match(modal, /hover:bg-rose-500\/15/);
});

test('profile save sends only an explicit canonical avatar mutation', () => {
  assert.deepEqual(cloudProfileSaveInput({
    displayNameDraft: 'Renamed user',
    avatarMutationDraft: null,
  }), {
    displayName: 'Renamed user',
  });

  assert.deepEqual(cloudProfileSaveInput({
    displayNameDraft: 'Renamed user',
    avatarMutationDraft: {
      action: 'upload',
      uploadedAsset: 'data:image/jpeg;base64,new',
      expectedVersion: 3,
    },
  }), {
    displayName: 'Renamed user',
    avatarMutation: {
      action: 'upload',
      uploadedAsset: 'data:image/jpeg;base64,new',
      expectedVersion: 3,
    },
  });
});

test('profile save sends only the optional fields that changed', () => {
  const saved = cloudProfileFieldDraft({
    accountId: 'acct_1', kordiId: '175791355', displayName: 'Maya', primaryEmail: null, avatarUrl: null,
    avatar: { entityType: 'human', entityId: 'acct_1', source: 'generated', style: 'lorelei', seed: 's', rendererVersion: 'v', uploadedAsset: null, version: 1, updatedAt: '' },
    about: 'Climber', location: 'Lisbon', timeZone: null, website: null, birthday: '1996-03-04', nodeId: null, passwordSet: false,
  });
  assert.deepEqual(saved, { kordiId: '', about: 'Climber', location: 'Lisbon', timeZone: '', website: '', birthday: '1996-03-04' });

  assert.deepEqual(cloudProfileSaveInput({
    displayNameDraft: ' Maya ',
    avatarMutationDraft: null,
    fieldDraft: { ...saved, kordiId: 'shuyhere', location: '', timeZone: 'Europe/Lisbon', about: 'Climber ' },
    savedFields: saved,
  }), { displayName: 'Maya', kordiId: 'shuyhere', location: '', timeZone: 'Europe/Lisbon' });
});

test('profile Kordi ID field keeps handles and routes server errors to their rows', () => {
  assert.equal(cloudProfileHandleDraft('175791355'), '');
  assert.equal(cloudProfileHandleDraft('ShuyHere'), 'ShuyHere');
  assert.equal(cloudProfileNumberPlaceholder({ kordiId: 'shuyhere', accountNumber: '175791355' }), '175791355');
  assert.equal(cloudProfileNumberPlaceholder({ kordiId: '175791355' }), '175791355');
  assert.equal(cloudProfileNumberPlaceholder({ kordiId: 'shuyhere' }), 'Account number');
  assert.equal(sanitizeKordiHandleInput('@shu_y-here!'), 'shuyhere');
  assert.equal(sanitizeKordiHandleInput('a'.repeat(40)).length, 30);

  assert.equal(cloudProfileErrorTarget(new CloudAuthError('kordi_id_taken', 'That Kordi ID is already taken.', 409)), 'kordiId');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('invalid_kordi_id', 'Use letters and numbers.', 400)), 'kordiId');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('kordi_id_change_locked', 'You can change your Kordi ID once a year.', 409)), 'kordiId');
  const now = Date.parse('2026-10-20T12:00:00Z');
  assert.equal(kordiIdLockedUntilLabel({ kordiIdChangeAvailableAt: '2027-03-04T12:00:00Z' }, now), 'March 4, 2027');
  assert.equal(kordiIdLockedUntilLabel({ kordiIdChangeAvailableAt: '2026-01-01T00:00:00Z' }, now), null);
  assert.equal(kordiIdLockedUntilLabel({ kordiIdChangeAvailableAt: null }, now), null);
  assert.equal(kordiIdLockedUntilLabel({}, now), null);
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('invalid_about', 'Too long.', 400)), 'about');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('invalid_location', 'Too long.', 400)), 'location');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('invalid_time_zone', 'Unknown.', 400)), 'timeZone');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('invalid_website', 'Bad URL.', 400)), 'website');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('invalid_birthday', 'Bad date.', 400)), 'birthday');
  assert.equal(cloudProfileErrorTarget(new CloudAuthError('server_error', 'Down.', 500)), 'form');
  assert.equal(cloudProfileErrorTarget(new Error('offline')), 'form');
});

test('profile editor does not reset avatar drafts while open for same account sync updates', () => {
  const modal = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(modal, /openedAccountIdRef/);
  assert.match(modal, /wasOpenRef\.current && openedAccountIdRef\.current === accountId/);
});

test('cloud profile updates publish owner snapshots and viewer-safe invalidations', () => {
  const profileHandlers = readFileSync(
    new URL('../../../bridges/cloud-server/src/auth/routes/profile_handlers.rs', import.meta.url),
    'utf8',
  );

  assert.match(profileHandlers, /identity_sync_recipient_ids/);
  assert.match(profileHandlers, /std::slice::from_ref\(&session\.account_id\)[\s\S]*"account\.profile\.updated"/);
  assert.match(profileHandlers, /&viewer_recipients,[\s\S]*"account\.directory\.changed"/);
  assert.match(profileHandlers, /for observer_account_id in observer_account_ids/);
});

test('auth notice opens the cloud account settings authentication panel', () => {
  const chatsPage = readSource('pages/chatsPage.mainWorkspace.tsx');
  const builders = readSource('app/mainContentShellBuilders.ts');
  const types = readSource('app/kordiShellSlots.types.ts');

  assert.match(chatsPage, /actionLabel="Open authentication"/);
  assert.match(chatsPage, /description=\{auth\.onOpenAccountAuthentication[\s\S]*Connect a provider,[\s\S]*Connect a cloud provider,/);
  assert.match(chatsPage, /auth\.onOpenAccountAuthentication \?\? auth\.onOpenAuthSettings/);
  assert.match(chatsPage, /onAction=\{openAuthentication\}/);
  assert.match(builders, /onOpenAccountAuthentication: args\.openCloudAccountAuthentication/);
  assert.match(types, /openCloudAccountAuthentication\?: \(\) => void/);
});

test('cloud contact websocket refreshes when a contact profile changes', () => {
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.profile.updated.acct_peer'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.contact.removed.acct_peer'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.account.signed_up.acct_peer'), false);
});
