import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';

import { withSessionActivityAt } from '../src/app/useKordiGroupCreation';
import {
  groupCreationErrorMessage,
  groupDissolveErrorMessage,
  groupInvitationLinkErrorMessage,
  groupNameIsValid,
  invitationExpiryLabel,
} from '../src/features/chat/groupCreateCopy';
import { canonicalMessageRole } from '../src/features/canonical/readModel/messageRole';
import { sessionChatActivityAtMs } from '../src/features/canonical/readModel/conversationMapping';
import type { CloudGroupInvitationCreateInput } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CreateChatGroupRequest } from '../src/app/kordiShellSlots.types';
import type { CanonicalSessionMessage, CanonicalSessionState, Contact } from '../src/kordi-app/types';
import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import { dissolvableChannelTarget } from '../src/pages/workspaceSidebar.chatHelpers';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const alice: Contact = {
  id: 'contact:alice',
  name: 'Alice',
  initials: 'A',
  classType: 'other-users',
  entityType: 'Person',
  subtitle: 'Human contact',
  collaborationSources: ['Bridge'],
  status: 'Online',
  discoverableOn: ['Bridge'],
  detail: '',
  owner: 'Alice',
  avatarSeed: 'alice',
  profileImageUrl: null,
};

type Harness = {
  host: HTMLElement;
  window: Window & typeof globalThis;
  closes: () => number;
  requests: CreateChatGroupRequest[];
  input: () => HTMLInputElement;
  button: (label: string) => HTMLButtonElement | undefined;
  type: (value: string) => Promise<void>;
  unmount: () => Promise<void>;
};

async function renderGroupForm({
  onCreateGroup,
  onCreateGroupInvitation,
}: {
  onCreateGroup: (request: CreateChatGroupRequest) => Promise<string | void>;
  onCreateGroupInvitation?: (input: CloudGroupInvitationCreateInput) => Promise<{ invitationId: string; inviteUrl: string; expiresAt: string }>;
}): Promise<Harness & { restore: () => void }> {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  // Loaded after the DOM exists, so React listens for real input events.
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  let closeCount = 0;
  const requests: CreateChatGroupRequest[] = [];
  await act(async () => {
    root.render(createElement(ChatCreateDialog, {
      isOpen: true,
      contacts: [alice],
      agents: [],
      onClose: () => { closeCount += 1; },
      onStartPerson: () => {},
      onStartAgent: () => {},
      onCreateGroup: async (request) => { requests.push(request); return onCreateGroup(request); },
      onCreateGroupInvitation: onCreateGroupInvitation ?? (async () => ({ invitationId: 'groupinv_0', inviteUrl: 'https://kordi.example/g/kordi_gi_0', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() })),
      initialMode: 'group',
    }));
  });
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
  return {
    host,
    window: installed.dom.window as unknown as Window & typeof globalThis,
    closes: () => closeCount,
    requests,
    input,
    button: (label) => [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label),
    type: async (value) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input(), value);
        input().dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
      });
    },
    unmount: async () => { await act(async () => root.unmount()); },
    restore: () => installed.restore(),
  };
}

test('a group needs a name: both actions stay off until one is typed, and the name field has focus', async () => {
  const view = await renderGroupForm({ onCreateGroup: async () => 'session:group:new' });
  try {
    assert.equal(view.input().placeholder, 'Group name');
    assert.equal(document.activeElement, view.input(), 'the name field is focused on open');
    assert.equal(view.button('Create group')?.disabled, true);
    assert.equal(view.host.querySelector('[role="group"] > button')?.textContent?.trim(), 'Invite with a link');
    assert.equal((view.host.querySelector('[role="group"] > button') as HTMLButtonElement).disabled, true);

    await view.type('   ');
    assert.equal(view.button('Create group')?.disabled, true, 'blank names do not count');

    await view.type('Launch QA');
    assert.equal(view.button('Create group')?.disabled, false);
    assert.equal((view.host.querySelector('[role="group"] > button') as HTMLButtonElement).disabled, false);
  } finally {
    await view.unmount();
    view.restore();
  }
});

test('Enter in the name field creates the group and closes the panel', async () => {
  const view = await renderGroupForm({ onCreateGroup: async () => 'session:group:new' });
  try {
    await view.type('  Launch QA  ');
    await act(async () => { view.input().form!.requestSubmit(); });
    await flushReactUpdates();
    assert.equal(view.requests.length, 1);
    assert.equal(view.requests[0].name, 'Launch QA');
    assert.deepEqual(view.requests[0].contactIds, []);
    assert.equal(view.closes(), 1, 'a created group closes the panel');
  } finally {
    await view.unmount();
    view.restore();
  }
});

test('a failed create shows short copy, never the server text, and keeps the panel open', async () => {
  const view = await renderGroupForm({
    onCreateGroup: async () => { throw new Error('group member count is invalid'); },
  });
  try {
    await view.type('Launch QA');
    await act(async () => { view.button('Create group')?.click(); });
    await flushReactUpdates();
    const alert = view.host.querySelector('.app-error-line[role="alert"]');
    assert.equal(alert?.firstElementChild?.textContent, "Couldn't create the group.");
    assert.equal(alert?.querySelector('.app-error-line-action')?.textContent, 'Try again');
    assert.doesNotMatch(view.host.textContent ?? '', /member count|verified group admin/);
    assert.equal(view.closes(), 0);
  } finally {
    await view.unmount();
    view.restore();
  }
});

test('Invite with a link shows one link with Copy, a toast and a check after copying, and closes on Done', async () => {
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const invitations: CloudGroupInvitationCreateInput[] = [];
  const view = await renderGroupForm({
    onCreateGroup: async () => 'session:group:linked',
    onCreateGroupInvitation: async (input) => {
      invitations.push(input);
      return { invitationId: 'groupinv_1', inviteUrl: 'https://kordi.example/g/kordi_gi_synthetic', expiresAt };
    },
  });
  const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  let copied = '';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied = text; } },
  });
  try {
    await view.type('Launch QA');
    await act(async () => { (view.host.querySelector('[role="group"] > button') as HTMLButtonElement).click(); });
    await flushReactUpdates();
    assert.equal(view.requests[0].name, 'Launch QA');
    assert.equal(view.requests[0].inviteLink, true);
    assert.deepEqual(invitations, [{ groupId: 'session:group:linked', groupSpaceId: 'session:group:linked', groupTitle: 'Launch QA' }]);
    assert.equal(view.host.querySelector<HTMLInputElement>('input[aria-label="Group invitation link"]')?.value, 'https://kordi.example/g/kordi_gi_synthetic');
    assert.match(view.host.textContent ?? '', /Expires in 7 days/);
    assert.equal(view.closes(), 0, 'the link step keeps the panel open');

    await act(async () => {
      view.host.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]')!.click();
      await Promise.resolve();
    });
    assert.equal(copied, 'https://kordi.example/g/kordi_gi_synthetic');
    assert.ok(view.host.querySelector('button[aria-label="Link copied"]'), 'the copy icon becomes a check');
    assert.equal(document.querySelector('.app-copy-toast[role="status"]')?.textContent, 'Link copied');

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
    assert.ok(view.host.querySelector('button[aria-label="Copy link"]'), 'the check returns to a copy icon');
    assert.equal(document.querySelector('.app-copy-toast'), null, 'the toast goes away');

    await act(async () => { view.button('Done')?.click(); });
    assert.equal(view.closes(), 1);
  } finally {
    if (clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
    else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    await view.unmount();
    view.restore();
  }
});

test('a link that fails after the group exists shows short copy and retries without a second group', async () => {
  let attempts = 0;
  const view = await renderGroupForm({
    onCreateGroup: async () => 'session:group:retry',
    onCreateGroupInvitation: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Only a verified group admin can create this invitation link.');
      return { invitationId: 'groupinv_2', inviteUrl: 'https://kordi.example/g/kordi_gi_retry', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    },
  });
  try {
    await view.type('Launch QA');
    const invite = () => view.host.querySelector('[role="group"] > button') as HTMLButtonElement;
    await act(async () => { invite().click(); });
    await flushReactUpdates();
    const alert = view.host.querySelector('.app-error-line[role="alert"]');
    assert.equal(alert?.firstElementChild?.textContent, "Couldn't create the link.");
    assert.doesNotMatch(view.host.textContent ?? '', /verified group admin/);
    const retry = alert?.querySelector<HTMLButtonElement>('.app-error-line-action');
    assert.equal(retry?.textContent, 'Try again');
    await act(async () => { retry!.click(); });
    await flushReactUpdates();
    assert.equal(view.requests.length, 1, 'the retry reuses the group');
    assert.match(view.host.textContent ?? '', /Expires in 1 day/);
  } finally {
    await view.unmount();
    view.restore();
  }
});

test('group names, link expiry and error copy', () => {
  assert.equal(groupNameIsValid(''), false);
  assert.equal(groupNameIsValid('   '), false);
  assert.equal(groupNameIsValid(null), false);
  assert.equal(groupNameIsValid(' Launch QA '), true);
  const now = Date.parse('2026-11-06T00:00:00Z');
  assert.equal(invitationExpiryLabel('2026-11-13T00:00:00Z', now), 'Expires in 7 days');
  assert.equal(invitationExpiryLabel('2026-11-06T02:00:00Z', now), 'Expires in 1 day');

  assert.equal(groupCreationErrorMessage(new Error('group member count is invalid')), "Couldn't create the group. Try again.");
  assert.equal(groupCreationErrorMessage(new TypeError('Failed to fetch')), "Couldn't reach Kordi. Check your connection and try again.");
  assert.equal(groupCreationErrorMessage(new Error("You can't message this person.")), "One of these people can't be added.");
  assert.equal(groupInvitationLinkErrorMessage(new Error('Only a verified group admin can create this invitation link.')), 'Only group admins can share a link.');
  assert.equal(groupInvitationLinkErrorMessage(new Error('Only a verified group admin can create this invitation link.'), { asCreator: true }), "Couldn't create the link. Try again.");
  assert.equal(groupDissolveErrorMessage(new Error('The account is not allowed to perform this operation.'), 'group'), 'Only group admins can dissolve this group.');
  assert.equal(groupDissolveErrorMessage(new Error('boom'), 'channel'), "Couldn't dissolve the channel. Try again.");
});

function session(overrides: Partial<CanonicalSessionState['sessions'][number]>): CanonicalSessionState['sessions'][number] {
  return {
    id: 'session:group:new',
    kind: 'group',
    title: 'Launch QA',
    status: 'active',
    createdByIdentityId: 'human:me',
    createdAtMs: 5_000,
    updatedAtMs: 5_000,
    lastMessageAtMs: null,
    ...overrides,
  };
}

test('a new group sorts at the top by its creation time until its first message', () => {
  assert.equal(sessionChatActivityAtMs(session({})), 5_000, 'an empty group uses its creation time');
  assert.equal(sessionChatActivityAtMs(session({ lastMessageAtMs: 9_000 })), 9_000);
  assert.equal(sessionChatActivityAtMs(session({ kind: 'direct-person' })), 0, 'other empty chats keep no activity');

  const state = {
    storagePath: '', profile: {} as never, identities: [], participants: [], messages: [],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
    sessions: [session({ id: 'session:group:old', createdAtMs: 1_000, lastMessageAtMs: 2_000 }), session({ id: 'session:group:new', createdAtMs: 3_000 })],
  } as CanonicalSessionState;
  const next = withSessionActivityAt(state, 'session:group:new', 7_000);
  assert.equal(next.sessions.find((item) => item.id === 'session:group:new')?.lastMessageAtMs, 7_000);
  assert.equal(next.sessions.find((item) => item.id === 'session:group:old')?.lastMessageAtMs, 2_000);
  const ordered = [...next.sessions].sort((left, right) => sessionChatActivityAtMs(right) - sessionChatActivityAtMs(left));
  assert.equal(ordered[0].id, 'session:group:new');
});

function notice(content: unknown): CanonicalSessionMessage {
  return {
    id: 'msg:created',
    sessionId: 'session:group:new',
    senderIdentityId: 'human:ava',
    senderRole: 'person',
    messageKind: 'system-notice',
    contentText: 'Ava created the group',
    content,
    status: 'complete',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  } as CanonicalSessionMessage;
}

test('a group event notice reads as a centered system line; other notices keep their bubble', () => {
  assert.equal(canonicalMessageRole(notice({ group_event: { type: 'group.created', actor_account_id: 'acct_ava' } })), 'system');
  assert.equal(canonicalMessageRole(notice({ blocks: [] })), 'person');
  assert.equal(canonicalMessageRole({ ...notice({ group_event: { type: 'group.created' } }), messageKind: 'text' }), 'person');
});

function channelSpace(adminIds: string[]) {
  const row = (id: string, createdAt: number) => ({
    id,
    canonicalSessionId: id,
    conversation: { canonicalCreatedAtMs: createdAt },
  });
  return {
    id: 'group:session:group:launch',
    kind: 'group',
    participants: [{ id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local' }],
    groupAdminIdentityIds: adminIds,
    sessions: [row('session:group:qa', 2_000), row('session:group:launch', 1_000)],
  } as never;
}

test('only a group admin may dissolve a channel, and never the group\'s first channel', () => {
  const space = channelSpace(['human:me']) as { sessions: unknown[] };
  const [qa, first] = space.sessions as never[];
  assert.deepEqual(dissolvableChannelTarget(space as never, qa), { groupSpaceId: 'session:group:launch' });
  assert.equal(dissolvableChannelTarget(space as never, first), null, 'the first channel is the group');
  const memberSpace = channelSpace([]) as { sessions: unknown[] };
  assert.equal(dissolvableChannelTarget(memberSpace as never, memberSpace.sessions[0] as never), null);
});

test('link failures name the cause the server gave', () => {
  assert.equal(groupInvitationLinkErrorMessage(new Error('Enter a group name before sharing an invitation.')), 'Name the group before sharing a link.');
  assert.equal(groupInvitationLinkErrorMessage(new Error('This group cannot create a share link.')), "This group can't share a link yet. Try again in a moment.");
  assert.equal(groupInvitationLinkErrorMessage(new Error('Only a verified group admin can create this invitation link.')), 'Only group admins can share a link.');
  assert.equal(groupInvitationLinkErrorMessage(new Error('Could not create invitation.')), "Couldn't create the link. Try again.");
  assert.equal(
    groupInvitationLinkErrorMessage(new CloudAuthError('rate_limited', 'Too many attempts. Try again in 30 seconds.', 429, 30)),
    'Too many links right now. Try again in 30 seconds.',
  );
});
