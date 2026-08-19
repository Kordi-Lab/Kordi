import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState } from '../src/features/cloud/cloudCollaborationState';
import { mergeCloudCollaborationOptimisticState } from '../src/features/cloud/useCloudCollaborationReadModel';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { createCloudCollaborationClientMessageId } from '../src/features/chat/messageActions/collaborationSendLifecycle';
import {
  appendOptimisticCollaborationMessage,
  markOptimisticCollaborationMessageFailed,
} from '../src/features/chat/messageActions/optimistic';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-08-11T00:00:00Z',
});

function outgoingMessage(
  messageId: string,
  body: string,
  clientMessageId: string,
  sequence: number,
): CloudMessage {
  return {
    messageId,
    clientMessageId,
    conversationId: 'conversation_direct',
    conversationSequence: sequence,
    version: 1,
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body,
    createdAt: `2026-08-11T00:00:${String(sequence).padStart(2, '0')}Z`,
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
  };
}

function authoritativeState(messages: CloudMessage[]) {
  return buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: messages },
  });
}

test('Cloud client message IDs are UUIDs suitable for chat idempotency', () => {
  assert.match(
    createCloudCollaborationClientMessageId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('optimistic Cloud messages overlay durable state without replacing it', () => {
  const durable = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
    outgoingMessage('message_2', 'second', '22222222-2222-4222-8222-222222222222', 2),
  ]);
  const conversationId = durable.conversations[0].id;
  const optimisticId = '33333333-3333-4333-8333-333333333333';
  const staleSnapshot = appendOptimisticCollaborationMessage(
    authoritativeState([
      outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
    ]),
    conversationId,
    'pending',
    '00:03',
    optimisticId,
  );

  const merged = mergeCloudCollaborationOptimisticState(durable, staleSnapshot);
  assert.deepEqual(
    merged?.conversations[0].messages.map((message) => message.text),
    ['first', 'second', 'pending'],
  );
});

test('the canonical snapshot replaces its matching optimistic message', () => {
  const optimisticId = '44444444-4444-4444-8444-444444444444';
  const initial = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
  ]);
  const optimistic = appendOptimisticCollaborationMessage(
    initial,
    initial.conversations[0].id,
    'hello',
    '00:02',
    optimisticId,
  );
  const durable = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
    outgoingMessage('message_2', 'hello', optimisticId, 2),
  ]);

  const merged = mergeCloudCollaborationOptimisticState(durable, optimistic);
  assert.equal(merged?.conversations[0].messages.length, 2);
  assert.equal(merged?.conversations[0].messages[1].id, 'message_2');
  assert.equal(merged?.conversations[0].messages[1].clientMessageId, optimisticId);
  assert.equal(merged?.conversations[0].messages[1].deliveryState, 'delivered');
});

test('failed optimistic messages remain retryable until canonical sync confirms the operation', () => {
  const optimisticId = '55555555-5555-4555-8555-555555555555';
  const initial = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
  ]);
  const optimistic = appendOptimisticCollaborationMessage(
    initial,
    initial.conversations[0].id,
    'retry me',
    '00:02',
    optimisticId,
  );
  const failed = markOptimisticCollaborationMessageFailed(
    optimistic,
    initial.conversations[0].id,
    optimisticId,
    'network timeout',
  );

  const beforeConfirmation = mergeCloudCollaborationOptimisticState(initial, failed);
  assert.equal(beforeConfirmation?.conversations[0].messages.at(-1)?.deliveryState, 'failed');

  const confirmed = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
    outgoingMessage('message_2', 'retry me', optimisticId, 2),
  ]);
  const afterConfirmation = mergeCloudCollaborationOptimisticState(confirmed, failed);
  assert.equal(afterConfirmation?.conversations[0].messages.length, 2);
  assert.equal(afterConfirmation?.conversations[0].messages.at(-1)?.id, 'message_2');
});

test('failed optimistic messages keep their chronological position after newer messages sync', () => {
  const optimisticId = '66666666-6666-4666-8666-666666666666';
  const initial = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
  ]);
  const optimistic = appendOptimisticCollaborationMessage(
    initial,
    initial.conversations[0].id,
    'failed second',
    '00:02',
    optimisticId,
  );
  const failed = markOptimisticCollaborationMessageFailed(
    optimistic && {
      ...optimistic,
      conversations: optimistic.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => (
          message.id === optimisticId
            ? { ...message, timestampMs: Date.parse('2026-08-11T00:00:02Z') }
            : message
        )),
      })),
    },
    initial.conversations[0].id,
    optimisticId,
    'network timeout',
  );
  const newer = authoritativeState([
    outgoingMessage('message_1', 'first', '11111111-1111-4111-8111-111111111111', 1),
    outgoingMessage('message_3', 'third', '33333333-3333-4333-8333-333333333333', 3),
  ]);

  const merged = mergeCloudCollaborationOptimisticState(newer, failed);
  assert.deepEqual(
    merged?.conversations[0].messages.map((message) => message.text),
    ['first', 'failed second', 'third'],
  );
});
