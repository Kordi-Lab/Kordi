import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { messageAttentionSnapshot, newMessageAttentionEvents } from '../src/features/notifications/messageAttentionPolicy';
import { messageAlertSuppressed } from '../src/features/safety/blockedMessageAlerts';
import {
  isMessageFromBlockedAccount,
  messageAuthorAccountId,
  shouldCollapseBlockedMessage,
} from '../src/features/safety/blockedMessageAuthor';
import { BLOCKED_MESSAGE_LABEL, BlockedMessageGate } from '../src/features/safety/BlockedMessageGate';
import { __resetRevealedBlockedMessagesForTests } from '../src/features/safety/blockedMessageReveal';
import { SafetyActionsContext, UNAVAILABLE_SAFETY_ACTIONS } from '../src/features/safety/safetyActions';
import type { Conversation, Message } from '../src/kordi-app/types';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const BLOCKED = 'acct_blocked_sam';
const FRIEND = 'acct_friend_ana';
const blocked = new Set([BLOCKED]);
const none = new Set<string>();

function peerMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'person',
    sender: 'Sam Rivera',
    senderType: 'human',
    senderIdentityId: `human:${BLOCKED}`,
    isOwnMessage: false,
    text: 'Synthetic hello',
    time: '9:00 AM',
    ...overrides,
  } as Message;
}

test('message authors resolve for people and for hosted agents whose identity names the owner', () => {
  assert.equal(messageAuthorAccountId(peerMessage()), BLOCKED);
  assert.equal(messageAuthorAccountId({ senderType: 'agent', senderIdentityId: `agent:cloud:${BLOCKED}` }), BLOCKED);
  assert.equal(messageAuthorAccountId({ senderType: 'agent', senderIdentityId: `agent:cloud:cloud-agent:${BLOCKED}` }), BLOCKED);
  assert.equal(messageAuthorAccountId({ senderType: 'agent', senderIdentityId: 'agent:cloud:custom-helper' }), null);
  assert.equal(messageAuthorAccountId({ senderType: 'agent', senderIdentityId: 'agent:local:abc' }), null);
  assert.equal(messageAuthorAccountId({ senderType: 'human', senderIdentityId: null }), null);
});

test('only other people\'s messages from a blocked account count as blocked', () => {
  assert.equal(isMessageFromBlockedAccount(peerMessage(), blocked), true);
  assert.equal(isMessageFromBlockedAccount(peerMessage(), none), false);
  assert.equal(isMessageFromBlockedAccount(peerMessage({ senderIdentityId: `human:${FRIEND}` }), blocked), false);
  assert.equal(isMessageFromBlockedAccount(peerMessage({ role: 'external-agent', senderType: 'agent', senderIdentityId: `agent:cloud:${BLOCKED}` }), blocked), true);
  assert.equal(isMessageFromBlockedAccount(peerMessage({ role: 'system' }), blocked), false);
  assert.equal(isMessageFromBlockedAccount(peerMessage({ role: 'user', isOwnMessage: true }), blocked), false);
  assert.equal(isMessageFromBlockedAccount(peerMessage({ role: 'owned-agent', senderType: 'agent' }), blocked), false);
});

test('blocked messages collapse only in group chats and stay open once revealed', () => {
  const message = peerMessage();
  const base = { message, blockedAccountIds: blocked, revealedKeys: new Set<string>() };
  assert.equal(shouldCollapseBlockedMessage({ ...base, groupConversation: true }), true);
  assert.equal(shouldCollapseBlockedMessage({ ...base, groupConversation: false }), false);
  assert.equal(shouldCollapseBlockedMessage({ ...base, groupConversation: true, revealedKeys: new Set(['msg-1']) }), false);
  assert.equal(shouldCollapseBlockedMessage({ ...base, groupConversation: true, blockedAccountIds: none }), false);
});

test('a blocked account\'s new message raises no alert, and later messages from others still do', () => {
  const conversation = (messages: Message[], unread: number) => ({
    id: 'group-1', name: 'Synthetic group', unread, messages,
  }) as unknown as Conversation;
  const isSuppressed = (message: Message) => messageAlertSuppressed(message, blocked);
  const first = conversation([peerMessage({ id: 'm-friend-0', senderIdentityId: `human:${FRIEND}` })], 0);
  const previous = messageAttentionSnapshot([first]);
  const fromBlocked = conversation([...first.messages, peerMessage({ id: 'm-blocked' })], 1);
  assert.deepEqual(newMessageAttentionEvents({ previous, conversations: [fromBlocked], isSuppressed }), []);
  assert.equal(newMessageAttentionEvents({ previous, conversations: [fromBlocked] }).length, 1);

  const afterBlocked = messageAttentionSnapshot([fromBlocked]);
  const fromFriend = conversation([...fromBlocked.messages, peerMessage({ id: 'm-friend-1', senderIdentityId: `human:${FRIEND}` })], 2);
  const events = newMessageAttentionEvents({ previous: afterBlocked, conversations: [fromFriend], isSuppressed });
  assert.deepEqual(events.map((event) => event.messageId), ['m-friend-1']);
});

test('the collapsed row reveals that one message when clicked', async () => {
  const installed = installDom();
  __resetRevealedBlockedMessagesForTests();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const value = { ...UNAVAILABLE_SAFETY_ACTIONS, blockedAccountIds: blocked };
  const render = (message: Message) => createElement(
    BlockedMessageGate,
    { message, groupConversation: true },
    createElement('p', { 'data-bubble': message.id }, message.text),
  );
  try {
    await act(async () => {
      root.render(createElement(SafetyActionsContext.Provider, { value },
        render(peerMessage({ id: 'm-a' })),
        render(peerMessage({ id: 'm-b' })),
        render(peerMessage({ id: 'm-c', senderIdentityId: `human:${FRIEND}` }))));
    });
    await flushReactUpdates();
    const rows = () => [...container.querySelectorAll('[data-blocked-message] button')];
    assert.equal(rows().length, 2);
    assert.equal(rows()[0]?.textContent, BLOCKED_MESSAGE_LABEL);
    assert.ok(container.querySelector('[data-bubble="m-c"]'));
    assert.equal(container.querySelector('[data-bubble="m-a"]'), null);

    await act(async () => { rows()[0]?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })); });
    await flushReactUpdates();
    assert.ok(container.querySelector('[data-bubble="m-a"]'));
    assert.equal(container.querySelector('[data-bubble="m-b"]'), null);
    assert.equal(rows().length, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    __resetRevealedBlockedMessagesForTests();
    installed.restore();
  }
});
