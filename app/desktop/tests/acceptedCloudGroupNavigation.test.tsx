import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { acceptedCloudGroupConversationId } from '../src/app/acceptedCloudGroupConversationId';
import { useAcceptedCloudGroupNavigation } from '../src/app/useAcceptedCloudGroupNavigation';
import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import { nativeChatPlaceholderForSelection } from '../src/app/viewModels/nativeChatSelection';
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
  const errors: string[] = [];
  function Harness() {
    useAcceptedCloudGroupNavigation({
      refreshCloudMessages: async () => { refreshes += 1; },
      setActiveConversationId: (id) => { activeId = id; },
      setActiveNavigation: (next) => { navigation = next; },
      setDesktopChatError: (message) => { errors.push(message); },
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
    assert.deepEqual(errors, []);

    // Not synced yet: a group placeholder, never another chat.
    const pending = select(activeId, chats);
    assert.equal(pending.id, GROUP_SESSION_ID);
    assert.equal(pending.directness, 'Group chat');
    assert.deepEqual(pending.messages, []);

    // Once conversation.created is applied, the same id selects the group.
    chats = [nadia, newGroup];
    const opened = select(activeId, chats);
    assert.equal(opened, newGroup);
    assert.equal(opened.name, 'Personal agent memory');

    // A legacy prefixed dispatch lands on the same session.
    await act(async () => {
      dispatchCloudGroupInvitationAccepted({ groupId: GROUP_SESSION_ID, groupSpaceId: `group:${GROUP_SESSION_ID}`, groupTitle: '' });
    });
    assert.equal(activeId, GROUP_SESSION_ID);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
