import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { acceptedCloudGroupConversationId } from '../src/app/acceptedCloudGroupConversationId';
import { useAcceptedCloudGroupNavigation } from '../src/app/useAcceptedCloudGroupNavigation';
import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import { nativeChatPlaceholderForSelection } from '../src/app/viewModels/nativeChatSelection';
import { collaborationGroupSessionSendTargets } from '../src/features/chat/messageActions/collaborationRouting';
import { cloudGroupTargetAccountIds } from '../src/features/cloud/cloudGroupMessages';
import { dispatchCloudGroupInvitationAccepted } from '../src/features/cloud/groupInvitationDeepLink';
import type { Conversation } from '../src/kordi-app/types';

const GROUP_SESSION_ID = 'session:group:6f0c2a1e-0000-4000-8000-0000fbb535a1';

function conversation(id: string, name: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    canonicalSessionId: id,
    name,
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Person chat',
    participants: ['Me'],
    messages: [],
    ...extra,
  };
}

const nadia = conversation('session:direct-person:acct_me:acct_nadia', 'Nadia');
const newGroup = conversation(GROUP_SESSION_ID, 'Personal agent memory', {
  type: 'owned-agent',
  directness: 'Group chat',
  participantSpaceId: GROUP_SESSION_ID,
});

function select(activeId: string, chats: Conversation[]) {
  return activeConversationForSelection(activeId, chats, {
    isNativeShell: true,
    nativeChatPlaceholder: nativeChatPlaceholderForSelection(activeId),
    fallbackConversation: chats[0],
  });
}

test('both group id forms resolve to the canonical group session id', () => {
  assert.equal(acceptedCloudGroupConversationId(GROUP_SESSION_ID), GROUP_SESSION_ID);
  assert.equal(acceptedCloudGroupConversationId(`group:${GROUP_SESSION_ID}`), GROUP_SESSION_ID);
  assert.equal(acceptedCloudGroupConversationId(`  ${GROUP_SESSION_ID} `), GROUP_SESSION_ID);
  assert.equal(acceptedCloudGroupConversationId(''), '');
  assert.equal(acceptedCloudGroupConversationId(undefined), '');
});

test('the old group: prefixed id matched no chat and fell back to the last direct chat', () => {
  // The pre-fix navigation id: the shell showed Nadia instead of the new group.
  assert.equal(select(`group:${GROUP_SESSION_ID}`, [nadia, newGroup]).name, 'Nadia');
});

test('accepted group navigation opens the new group, before and after it syncs', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(document.getElementById('root')!);
  // The store holds only the direct chat until the first refresh lands.
  let chats: Conversation[] = [nadia];
  let refreshes = 0;
  let activeId = nadia.id;
  let navigation = '';
  // A banner left over from the previous chat (a failed send there).
  let banner: string | null = 'This chat is unavailable. Try again from the chat list.';
  const errors: Array<string | null> = [];
  function Harness() {
    useAcceptedCloudGroupNavigation({
      refreshCloudMessages: async () => {
        refreshes += 1;
        // conversation.created lands a moment after the refresh resolves.
        setTimeout(() => { chats = [nadia, newGroup]; }, 20);
      },
      setActiveConversationId: (id) => { activeId = id; },
      setActiveNavigation: (next) => { navigation = next; },
      setDesktopChatError: (message) => { banner = message; errors.push(message); },
    });
    return null;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    // Common ground Start group / Join both dispatch the server groupSpaceId.
    await act(async () => {
      dispatchCloudGroupInvitationAccepted({ groupId: GROUP_SESSION_ID, groupSpaceId: GROUP_SESSION_ID, groupTitle: '' });
    });
    assert.equal(refreshes, 1);
    assert.equal(navigation, 'chats');
    assert.equal(activeId, GROUP_SESSION_ID);
    // Opening clears the stale banner and raises none of its own.
    assert.deepEqual(errors, [null]);
    assert.equal(banner, null);

    // Not synced yet: a group placeholder, never another chat.
    assert.deepEqual(chats, [nadia]);
    const pending = select(activeId, chats);
    assert.equal(pending.id, GROUP_SESSION_ID);
    assert.equal(pending.directness, 'Group chat');
    assert.deepEqual(pending.messages, []);

    // Once conversation.created is applied, the same id selects the group.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(chats, [nadia, newGroup]);
    const opened = select(activeId, chats);
    assert.equal(opened, newGroup);
    assert.equal(opened.name, 'Personal agent memory');

    // A legacy prefixed dispatch lands on the same session.
    await act(async () => {
      dispatchCloudGroupInvitationAccepted({ groupId: GROUP_SESSION_ID, groupSpaceId: `group:${GROUP_SESSION_ID}`, groupTitle: '' });
    });
    assert.equal(activeId, GROUP_SESSION_ID);
    assert.ok(errors.every((message) => message === null));
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('a group whose invitees have not joined yet has no Cloud send target', () => {
  // Documents the send-path condition behind "This chat is unavailable":
  // chatMessages.ts only takes the Cloud group branch when targets exist.
  const soloGroup = {
    canonicalParticipants: [
      { id: 'me', name: 'Me', kind: 'human', role: 'self', source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: 'acct_me' },
      { id: 'agent', name: 'Kordi', kind: 'agent', role: 'agent', source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: 'acct_me' },
    ],
  } as unknown as Pick<Conversation, 'canonicalParticipants'>;
  assert.deepEqual(cloudGroupTargetAccountIds(collaborationGroupSessionSendTargets(soloGroup, null, ['acct_me'])), []);
});
