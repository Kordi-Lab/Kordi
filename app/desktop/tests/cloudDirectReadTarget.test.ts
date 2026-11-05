import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { cloudDirectReadTarget } from '../src/features/cloud/cloudReadTracking';
import { canMarkActiveConversationRead } from '../src/features/cloud/activeConversationReadPolicy';
import {
  cloudCollaborationConversationId,
  cloudDirectPersonSessionId,
  cloudSystemAgentConversationId,
  cloudSystemAgentSessionId,
} from '../src/features/collaboration/conversationIds';

const account = { accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.test' } as CloudAccount;
const supportOwner = 'acct_support';
const supportAgent = 'cloud_agent_kordi_support';
const supportSessionId = cloudSystemAgentSessionId(account.accountId, supportAgent);
const supportConversationId = cloudSystemAgentConversationId(account.accountId, supportOwner, supportAgent);

function message(input: Partial<CloudMessage> & Pick<CloudMessage, 'messageId' | 'fromAccountId' | 'toAccountId'>): CloudMessage {
  const incoming = input.fromAccountId !== account.accountId;
  return {
    body: 'hello',
    createdAt: '2026-11-04T22:10:00Z',
    deliveredAt: '2026-11-04T22:10:00Z',
    readAt: null,
    direction: incoming ? 'incoming' : 'outgoing',
    ...input,
  };
}

function supportConversation(readThrough = 0): CloudMessage[] {
  const rows: CloudMessage[] = [
    message({ messageId: 'm1', fromAccountId: account.accountId, toAccountId: supportOwner, conversationSequence: 1 }),
    message({ messageId: 'm2', fromAccountId: supportOwner, toAccountId: account.accountId, conversationSequence: 2 }),
    message({ messageId: 'm3', fromAccountId: account.accountId, toAccountId: supportOwner, conversationSequence: 3 }),
    message({ messageId: 'm4', fromAccountId: supportOwner, toAccountId: account.accountId, conversationSequence: 4 }),
  ];
  return rows.map(row => ({
    ...row,
    sessionId: supportSessionId,
    readAt: row.fromAccountId === supportOwner && (row.conversationSequence ?? 0) <= readThrough ? row.createdAt : null,
  }));
}

test('an open Kordi Support chat reads the agent replies it shows', () => {
  const index = buildCloudMessageIndex(account.accountId, { [supportOwner]: supportConversation() });
  assert.deepEqual(cloudDirectReadTarget(account, supportConversationId, index), {
    peerId: supportOwner,
    sessionId: supportSessionId,
    messageIds: ['m2', 'm4'],
    observedSequence: 4,
  });
});

test('a support reply that arrives while the chat is open is the only new read', () => {
  // The first reply was read on open; the second reply streams in afterwards.
  const index = buildCloudMessageIndex(account.accountId, { [supportOwner]: supportConversation(2) });
  assert.deepEqual(cloudDirectReadTarget(account, supportConversationId, index), {
    peerId: supportOwner,
    sessionId: supportSessionId,
    messageIds: ['m4'],
    observedSequence: 4,
  });
  const allRead = buildCloudMessageIndex(account.accountId, { [supportOwner]: supportConversation(4) });
  assert.equal(cloudDirectReadTarget(account, supportConversationId, allRead), null);
});

test('a bare system agent session id resolves the agent owner from its messages', () => {
  const index = buildCloudMessageIndex(account.accountId, { [supportOwner]: supportConversation() });
  assert.deepEqual(cloudDirectReadTarget(account, supportSessionId, index)?.peerId, supportOwner);
});

test('support replies never count as read in the person chat with the same account', () => {
  const personSessionId = cloudDirectPersonSessionId(account.accountId, supportOwner);
  const personMessage = message({
    messageId: 'p1',
    fromAccountId: supportOwner,
    toAccountId: account.accountId,
    sessionId: personSessionId,
    conversationSequence: 7,
  });
  const index = buildCloudMessageIndex(account.accountId, {
    [supportOwner]: [...supportConversation(), personMessage],
  });
  assert.deepEqual(
    cloudDirectReadTarget(account, cloudCollaborationConversationId(supportOwner, 'person'), index),
    { peerId: supportOwner, sessionId: personSessionId, messageIds: ['p1'], observedSequence: 7 },
  );
  assert.deepEqual(cloudDirectReadTarget(account, supportConversationId, index)?.messageIds, ['m2', 'm4']);
});

test('a person chat still reads incoming messages from that person', () => {
  const peer = 'acct_peer';
  const sessionId = cloudDirectPersonSessionId(account.accountId, peer);
  const index = buildCloudMessageIndex(account.accountId, {
    [peer]: [
      message({ messageId: 'a', fromAccountId: peer, toAccountId: account.accountId, sessionId, conversationSequence: 1 }),
      message({ messageId: 'b', fromAccountId: account.accountId, toAccountId: peer, sessionId, conversationSequence: 2 }),
    ],
  });
  assert.deepEqual(cloudDirectReadTarget(account, cloudCollaborationConversationId(peer, 'person'), index), {
    peerId: peer,
    sessionId,
    messageIds: ['a'],
    observedSequence: 1,
  });
});

test('a person chat reads the completed reply from the owner agent', () => {
  const peer = 'acct_peer';
  const sessionId = cloudDirectPersonSessionId(account.accountId, peer);
  const reply = message({
    messageId: 'agent-reply',
    fromAccountId: account.accountId,
    toAccountId: peer,
    sessionId,
    conversationSequence: 3,
    body: encodeCloudAgentResponse({ requestId: 'request-1', text: 'Done', deliveryState: 'complete' }),
  });
  const index = buildCloudMessageIndex(account.accountId, { [peer]: [reply] });
  assert.deepEqual(
    cloudDirectReadTarget(account, cloudCollaborationConversationId(peer, 'person'), index)?.messageIds,
    ['agent-reply'],
  );
});

test('a system agent chat for another account is never read here', () => {
  const index = buildCloudMessageIndex(account.accountId, { [supportOwner]: supportConversation() });
  const otherSessionId = cloudSystemAgentSessionId('acct_other', supportAgent);
  const foreign = buildCloudMessageIndex(account.accountId, {
    [supportOwner]: supportConversation().map(row => ({ ...row, sessionId: otherSessionId })),
  });
  assert.equal(cloudDirectReadTarget(account, otherSessionId, foreign), null);
  assert.equal(
    cloudDirectReadTarget(account, cloudSystemAgentConversationId('acct_other', supportOwner, supportAgent), index),
    null,
  );
});

test('messages stay unread while the window is not focused', () => {
  const visible = { isSelected: true, isTranscriptPresented: true, isAtLatest: true };
  assert.equal(canMarkActiveConversationRead({ ...visible, isAppForeground: false }), false);
  assert.equal(canMarkActiveConversationRead({ ...visible, isAppForeground: true }), true);
});
