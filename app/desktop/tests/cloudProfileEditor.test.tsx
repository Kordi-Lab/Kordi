import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';

import type { CloudProfileUpdateInput } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CloudAccount } from '../src/features/cloud/cloudIdentityTypes';
import { CloudAccountSettingsDialog } from '../src/pages/CloudAccountSettingsDialog';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { installDom } from './helpers/transcriptAttachmentDom';

const account: CloudAccount = {
  accountId: 'acct_1', kordiId: 'mayaold', accountNumber: '175791355', displayName: 'Maya', primaryEmail: 'maya@example.com',
  primaryEmailVerified: true, about: 'Weekend climber.', location: 'Lisbon', timeZone: null, website: null,
  birthday: '1996-03-04', avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true,
};

const noop = () => {};
const asyncNoop = async () => {};
const dialog = (current: CloudAccount, onUpdateProfile: (input: CloudProfileUpdateInput) => Promise<void>) => createElement(CloudAccountSettingsDialog, {
  isOpen: true, account: current, onClose: noop, onUpdateProfile,
  settingsSections: [], activeSettingsSectionId: 'appearance', setActiveSettingsSectionId: noop,
  authSettingsLayoutWidth: 600, isNativeShell: false, desktopAuthState: null, isDesktopAuthLoading: false,
  desktopAuthError: null, activeLoginProviderId: null, selectAuthProvider: noop, openLoginFlow: noop,
  refreshDesktopAuth: asyncNoop, handleSelectAuthChoice: asyncNoop, handleRemoveAuthProfile: asyncNoop,
  handleLogoutProvider: asyncNoop, themeMode: 'dark', setThemeMode: noop, connectorsClient: null,
  memoryClient: null,
});

function labelledField(label: string) {
  const element = Array.from(document.querySelectorAll('label')).find((item) => item.textContent === label);
  assert.ok(element, label);
  return document.getElementById(element.htmlFor) as HTMLInputElement;
}

test('profile table saves changed fields and shows a taken Kordi ID under its row', async () => {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const sent: CloudProfileUpdateInput[] = [];
  const onUpdateProfile = async (input: CloudProfileUpdateInput) => {
    sent.push(input);
    throw new CloudAuthError('kordi_id_taken', 'That Kordi ID is already taken.', 409);
  };
  const field = labelledField;
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
    });
  };
  const saveButton = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save')!;
  try {
    await act(async () => root.render(dialog(account, onUpdateProfile)));

    const rows = Array.from(document.querySelectorAll('.app-cloud-profile-row')).map((row) => row.querySelector('.app-cloud-profile-row-label')?.textContent);
    assert.deepEqual(rows, ['Name', 'Kordi ID', 'About', 'Location', 'Time zone', 'Website', 'Birthday', 'Email']);
    const kordiId = field('Kordi ID');
    assert.equal(kordiId.value, 'mayaold');
    assert.equal(kordiId.placeholder, '175791355');
    assert.equal(document.querySelector('.app-cloud-profile-save')?.previousElementSibling?.className.includes('app-settings-section'), true);
    assert.equal(field('Website').placeholder, 'Add your website');
    assert.equal(saveButton().disabled, true);

    await type(kordiId, '@ma_ya');
    assert.equal(kordiId.value, 'maya');
    assert.equal(saveButton().disabled, false);
    await act(async () => saveButton().click());

    assert.deepEqual(sent, [{ displayName: 'Maya', kordiId: 'maya' }]);
    const alert = kordiId.closest('.app-cloud-profile-row')!.querySelector('[role="alert"]');
    assert.equal(alert?.textContent, 'That Kordi ID is already taken.');
    assert.equal(kordiId.getAttribute('aria-invalid'), 'true');

    await type(kordiId, 'mayab');
    assert.equal(kordiId.getAttribute('aria-invalid'), null);
    assert.equal(document.querySelector('.app-cloud-profile-row [role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('a Kordi ID changed within the year is read-only until its next change date', async () => {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const locked = { ...account, kordiIdChangeAvailableAt: '2999-03-04T12:00:00Z' };
    await act(async () => root.render(dialog(locked, asyncNoop)));
    const kordiId = labelledField('Kordi ID');
    assert.equal(kordiId.disabled, true);
    assert.equal(kordiId.value, 'mayaold');
    const note = kordiId.closest('.app-cloud-profile-row')!.querySelector('.app-cloud-profile-row-note');
    assert.equal(note?.textContent, 'Changes again on March 4, 2999');
    assert.match(kordiId.getAttribute('aria-describedby') ?? '', new RegExp(note!.id));

    await act(async () => root.render(dialog({ ...account, kordiIdChangeAvailableAt: null }, asyncNoop)));
    assert.equal(labelledField('Kordi ID').disabled, false);
    assert.equal(document.querySelector('.app-cloud-profile-row-note'), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
