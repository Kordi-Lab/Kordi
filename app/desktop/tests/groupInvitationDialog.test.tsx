import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { CloudAuthError } from '../src/features/cloud/authClient';
import type {
  CloudGroupInvitationAcceptance,
  CloudGroupInvitationPreview,
  CloudPendingGroupInvitation,
} from '../src/features/cloud/cloudIdentityTypes';
import { GroupInvitationDialog } from '../src/pages/GroupInvitationDialog';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const TOKEN = `kordi_gi_${'a'.repeat(43)}`;
const PREVIEW: CloudGroupInvitationPreview = {
  inviter: { displayName: 'Ethan Park', kordiId: '123456789', avatarUrl: null },
  group: { name: 'Product Team', memberCount: 5 },
  expiresAt: '2026-11-12T00:00:00Z',
};
const PENDING: CloudPendingGroupInvitation = {
  id: 'p_new',
  invitationId: 'inv_new',
  groupName: 'Reading group',
  inviterName: 'Maya Chen',
  memberCount: 3,
  expiresAt: '2026-11-12T00:00:00Z',
};
const JOINED: CloudGroupInvitationAcceptance = {
  status: 'joined', groupId: 'g', groupSpaceId: 'g', groupTitle: 'Reading group',
};

const flush = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
const dialog = (host: HTMLElement) => host.querySelector('[role="dialog"]') as HTMLElement;
const buttonLabels = (host: HTMLElement) => [...host.querySelectorAll('button')]
  .map((candidate) => candidate.textContent?.trim() || candidate.getAttribute('aria-label'));
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')]
  .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;

function tokenDialog(resolve: () => Promise<CloudGroupInvitationPreview>, onDismiss = () => {}) {
  return createElement(GroupInvitationDialog, {
    invitationToken: TOKEN,
    onDismiss,
    onJoined: () => {},
    client: { resolveGroupInvitation: resolve, acceptGroupInvitation: async () => JOINED },
    loadToken: async () => 'session-token',
  });
}

test('both modes open with focus on Join and show a ring only after Tab', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(createElement(GroupInvitationDialog, {
      pendingInvitation: PENDING,
      onAcceptPending: async () => JOINED,
      onDismiss: () => {},
      onJoined: () => {},
    }));
    await flush();
    assert.equal(document.activeElement, button(host, 'Join'));
    assert.equal(dialog(host).hasAttribute('data-keyboard-nav'), false);
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    assert.equal(dialog(host).getAttribute('data-keyboard-nav'), 'true');
    await act(async () => {
      dialog(host).dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    assert.equal(dialog(host).hasAttribute('data-keyboard-nav'), false);
  });
  await withJsdomRoot(async (mount) => {
    const host = await mount(tokenDialog(async () => PREVIEW));
    await waitForReactCondition(() => Boolean(button(host, 'Join')), 'deep-link preview should load');
    await flush();
    assert.equal(document.activeElement, button(host, 'Join'));
    assert.equal(dialog(host).hasAttribute('data-keyboard-nav'), false);
  });
});

test('an expired link offers only Close with a neutral line', async () => {
  await withJsdomRoot(async (mount) => {
    let dismissed = 0;
    const host = await mount(tokenDialog(async () => {
      throw new CloudAuthError('group_invitation_expired', 'expired', 410);
    }, () => { dismissed += 1; }));
    await waitForReactCondition(() => Boolean(button(host, 'Close')), 'expired state should show');
    assert.deepEqual(buttonLabels(host), ['Dismiss group invitation', 'Close']);
    const line = host.querySelector('[role="status"]');
    assert.equal(line?.textContent, 'This link expired. Ask the sender for a new one.');
    assert.doesNotMatch(line?.className ?? '', /rose|danger/);
    assert.equal(host.querySelector('[role="alert"]'), null);
    await act(async () => { button(host, 'Close')?.click(); });
    assert.equal(dismissed, 1);
  });
});

test('only a network failure offers Try again', async () => {
  await withJsdomRoot(async (mount) => {
    let attempts = 0;
    const host = await mount(tokenDialog(async () => {
      attempts += 1;
      if (attempts === 1) throw new CloudAuthError('network_error', 'offline', 0);
      return PREVIEW;
    }));
    await waitForReactCondition(() => Boolean(button(host, 'Try again')), 'network error should show');
    assert.ok(host.querySelector('[role="alert"]'));
    assert.ok(button(host, 'Not now'));
    await act(async () => { button(host, 'Try again')?.click(); });
    await waitForReactCondition(() => Boolean(button(host, 'Join')), 'retry should load the preview');
    assert.equal(attempts, 2);
  });
});
