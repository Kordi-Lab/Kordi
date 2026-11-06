import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useCallback, useState } from 'react';

import { CloudAuthError } from '../src/features/cloud/authClient';
import type {
  CloudGroupInvitationPreview,
  CloudPendingGroupInvitation,
} from '../src/features/cloud/cloudIdentityTypes';
import {
  CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
  type CloudGroupInvitationAcceptedDetail,
} from '../src/features/cloud/groupInvitationDeepLink';
import {
  PENDING_GROUP_INVITATION_REFRESH_MS,
  type GroupInvitationPromptClient,
} from '../src/features/cloud/useServerPendingGroupInvitations';
import { GroupInvitationPromptHost } from '../src/pages/GroupInvitationPromptHost';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const TOKEN = `kordi_gi_${'a'.repeat(43)}`;

function pending(id: string, groupName: string, extra: Partial<CloudPendingGroupInvitation> = {}): CloudPendingGroupInvitation {
  return {
    id,
    invitationId: `inv_${id}`,
    groupName,
    inviterName: 'Maya Chen',
    memberCount: 3,
    expiresAt: '2026-11-12T00:00:00Z',
    ...extra,
  };
}

const PREVIEW: CloudGroupInvitationPreview = {
  inviter: { displayName: 'Ethan Park', kordiId: '123456789', avatarUrl: null },
  group: { name: 'Product Team', memberCount: 5 },
  expiresAt: '2026-11-12T00:00:00Z',
};

function fakeClient(list: () => CloudPendingGroupInvitation[], overrides: Partial<GroupInvitationPromptClient> = {}) {
  const calls = {
    list: 0,
    claim: [] as string[],
    accept: [] as string[],
    dismiss: [] as string[],
    tokenAccept: [] as string[],
  };
  const client: GroupInvitationPromptClient = {
    resolveGroupInvitation: async () => PREVIEW,
    acceptGroupInvitation: async (_token, invitationToken) => {
      calls.tokenAccept.push(invitationToken);
      return { status: 'joined', groupId: 'group:product', groupSpaceId: 'session:group:product', groupTitle: 'Product Team' };
    },
    claimGroupInvitation: async (_token, invitationToken) => {
      calls.claim.push(invitationToken);
      return { pending: pending('p_claimed', 'Product Team'), deepLink: `kordi://group-invite/${invitationToken}` };
    },
    listPendingGroupInvitations: async () => {
      calls.list += 1;
      return list();
    },
    acceptPendingGroupInvitation: async (_token, pendingId) => {
      calls.accept.push(pendingId);
      return {
        conversationId: 'session:group:reading',
        status: 'joined',
        groupId: 'group:reading',
        groupSpaceId: 'session:group:reading',
        groupTitle: 'Reading group',
      };
    },
    dismissPendingGroupInvitation: async (_token, pendingId) => {
      calls.dismiss.push(pendingId);
    },
    ...overrides,
  };
  return { client, calls };
}

const loadToken = async () => 'session-token';

function Harness({ client, initialToken = null }: { client: GroupInvitationPromptClient; initialToken?: string | null }) {
  const [token, setToken] = useState<string | null>(initialToken);
  const dismiss = useCallback(() => setToken(null), []);
  return createElement(GroupInvitationPromptHost, {
    deepLink: { token, dismiss },
    visible: true,
    client,
    loadToken,
  });
}

const flush = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
const dialogs = (host: HTMLElement) => host.querySelectorAll('[role="dialog"]');
const title = (host: HTMLElement) => host.querySelector('#group-invitation-title')?.textContent ?? '';
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')]
  .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;

async function withPromptDom(run: Parameters<typeof withJsdomRoot>[0]) {
  await withJsdomRoot(async (mount, root) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
    Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
    try {
      await run(mount, root);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'CustomEvent', previous);
    }
  });
}

test('the newest server invitation shows, and Join accepts it and opens the chat', async () => {
  await withPromptDom(async (mount) => {
    const { client, calls } = fakeClient(() => [pending('p_new', 'Reading group'), pending('p_old', 'Design club')]);
    const accepted: CloudGroupInvitationAcceptedDetail[] = [];
    const onAccepted = (event: Event) => {
      accepted.push((event as CustomEvent<CloudGroupInvitationAcceptedDetail>).detail);
    };
    window.addEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAccepted);
    const host = await mount(createElement(Harness, { client }));
    await waitForReactCondition(() => dialogs(host).length === 1, 'pending dialog should show');
    assert.equal(title(host), 'Join Reading group?');
    assert.match(host.textContent ?? '', /Maya Chen invited you · 3 members/);
    assert.equal(calls.list, 1);

    await act(async () => { button(host, 'Join')?.click(); });
    await flush();
    assert.deepEqual(calls.accept, ['p_new']);
    assert.deepEqual(accepted, [{ groupId: 'group:reading', groupSpaceId: 'session:group:reading', groupTitle: 'Reading group' }]);
    assert.equal(dialogs(host).length, 1);
    assert.equal(title(host), 'Join Design club?');
    window.removeEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAccepted);
  });
});

test('Not now dismisses on the server and drops the invitation even when the DELETE fails', async () => {
  await withPromptDom(async (mount) => {
    const dismissed: string[] = [];
    const { client } = fakeClient(() => [pending('p_new', 'Reading group')], {
      dismissPendingGroupInvitation: async (_token, pendingId) => {
        dismissed.push(pendingId);
        throw new CloudAuthError('network_error', 'offline', 0);
      },
    });
    const host = await mount(createElement(Harness, { client }));
    await waitForReactCondition(() => dialogs(host).length === 1, 'pending dialog should show');
    await act(async () => { button(host, 'Not now')?.click(); });
    await flush();
    assert.deepEqual(dismissed, ['p_new']);
    assert.equal(dialogs(host).length, 0);
  });
});

test('Join shows the full-group message from the server', async () => {
  await withPromptDom(async (mount) => {
    const { client } = fakeClient(() => [pending('p_new', 'Reading group')], {
      acceptPendingGroupInvitation: async () => { throw new CloudAuthError('group_full', 'full', 409); },
    });
    const host = await mount(createElement(Harness, { client }));
    await waitForReactCondition(() => dialogs(host).length === 1, 'pending dialog should show');
    await act(async () => { button(host, 'Join')?.click(); });
    await flush();
    assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /This group is full\./);
    assert.ok(button(host, 'Close'), 'a full group can only be closed');
    assert.equal(button(host, 'Join'), undefined);
  });
});

test('focus and visibility refreshes run at most once per throttle window', async () => {
  await withPromptDom(async (mount) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const { client, calls } = fakeClient(() => []);
      await mount(createElement(Harness, { client }));
      await flush();
      assert.equal(calls.list, 1);
      await act(async () => { window.dispatchEvent(new window.Event('focus')); });
      await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
      await flush();
      assert.equal(calls.list, 1);
      now += PENDING_GROUP_INVITATION_REFRESH_MS + 1;
      await act(async () => { window.dispatchEvent(new window.Event('focus')); });
      await flush();
      assert.equal(calls.list, 2);
      await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
      await flush();
      assert.equal(calls.list, 2);
    } finally {
      Date.now = realNow;
    }
  });
});

test('a deep link claims on the server, wins over pending ones, and does not pop again', async () => {
  await withPromptDom(async (mount) => {
    let serverList = [pending('p_claimed', 'Product Team'), pending('p_other', 'Design club')];
    const { client, calls } = fakeClient(() => serverList, {
      dismissPendingGroupInvitation: async (_token, pendingId) => {
        calls.dismiss.push(pendingId);
        serverList = serverList.filter((item) => item.id !== pendingId);
      },
    });
    const host = await mount(createElement(Harness, { client, initialToken: TOKEN }));
    await waitForReactCondition(() => title(host) === 'Join Product Team?', 'deep-link dialog should show');
    assert.deepEqual(calls.claim, [TOKEN]);
    assert.equal(dialogs(host).length, 1);
    assert.match(host.textContent ?? '', /Ethan Park invited you · 5 members/);

    await act(async () => { button(host, 'Not now')?.click(); });
    await waitForReactCondition(() => title(host) === 'Join Design club?', 'next pending dialog should show');
    assert.deepEqual(calls.dismiss, ['p_claimed']);
    assert.equal(calls.list, 2);
    assert.equal(dialogs(host).length, 1);
  });
});

test('joining from a deep link opens the chat and answers its server copy', async () => {
  await withPromptDom(async (mount) => {
    const { client, calls } = fakeClient(() => [pending('p_claimed', 'Product Team')]);
    const accepted: string[] = [];
    const onAccepted = (event: Event) => {
      accepted.push((event as CustomEvent<CloudGroupInvitationAcceptedDetail>).detail.groupSpaceId);
    };
    window.addEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAccepted);
    const host = await mount(createElement(Harness, { client, initialToken: TOKEN }));
    await waitForReactCondition(() => title(host) === 'Join Product Team?', 'deep-link dialog should show');
    await act(async () => { button(host, 'Join')?.click(); });
    await flush();
    await flush();
    assert.deepEqual(calls.tokenAccept, [TOKEN]);
    assert.deepEqual(accepted, ['session:group:product']);
    assert.deepEqual(calls.dismiss, ['p_claimed']);
    assert.equal(dialogs(host).length, 0);
    window.removeEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAccepted);
  });
});
