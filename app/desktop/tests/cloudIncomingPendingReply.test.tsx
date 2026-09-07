import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudCollaborationConversation } from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { encodeCloudAgentCancel, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

const owner: CloudAccount = {
  accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar,
  nodeId: 'owner', passwordSet: true,
  defaultAgent: { agentId: 'cloud-agent:owner', displayName: 'Target Agent', avatarUrl: null, avatar },
};
const peer: CloudAccount = { ...owner, accountId: 'peer', displayName: 'Peer', nodeId: 'peer', defaultAgent: null };

function request(id: string, sender: CloudAccount, createdAt: number): CloudMessage {
  return {
    messageId: id, clientMessageId: `ios-client-${id}`, fromAccountId: sender.accountId,
    toAccountId: sender === owner ? peer.accountId : owner.accountId,
    createdAt: new Date(createdAt).toISOString(), deliveredAt: null, readAt: null,
    direction: sender === owner ? 'outgoing' : 'incoming',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1, kind: 'message', text: '@TargetAgent check the weather',
      targetCloudAgentId: owner.defaultAgent!.agentId, targetCloudAgentName: 'Target Agent',
      targetCloudAgentOwnerAccountId: owner.accountId, targetCloudAgentOwnerName: owner.displayName,
    }),
  };
}

function conversation(viewer: CloudAccount, messages: CloudMessage[]) {
  return buildCloudCollaborationConversation({
    account: viewer, contact: cloudContactToContact({ ...(viewer === owner ? peer : owner), createdAt: new Date().toISOString() }),
    messages, runtime: 'person',
  });
}

test('an iOS inbound Agent request has one pending bubble after an older outgoing request is cancelled or expired', () => {
  const now = Date.now();
  for (const previousState of ['cancelled', 'expired']) {
    const previous = request('old', owner, now - (previousState === 'expired' ? 20 * 60_000 : 60_000));
    const messages = [previous];
    if (previousState === 'cancelled') messages.push({ ...previous, messageId: 'cancel', fromAccountId: peer.accountId, toAccountId: owner.accountId,
      body: encodeCloudAgentCancel({ requestId: previous.messageId }), createdAt: new Date(now - 30_000).toISOString() });
    const incoming = request('incoming-ios', peer, now);
    messages.push(incoming);
    for (const viewer of [owner, peer]) {
      const projected = conversation(viewer, messages);
      const view = mapCollaborationConversationToViewModel(projected, undefined, 'Target Agent', now);
      const pending = view.messages.filter(message => message.turn && !message.turn.completed);
      assert.equal(pending.length, 1, `${previousState}, viewer=${viewer.accountId}`);
      assert.equal(pending[0].sender, 'Target Agent');
      assert.equal(pending[0].role, viewer === owner ? 'owned-agent' : 'external-agent');
      assert.equal(pending[0].senderOwnerName ?? (pending[0].role === 'owned-agent' ? 'You' : null), viewer === owner ? 'You' : 'Owner');
      assert.equal(pending[0].replyToMessageId, `collaboration-message:${projected.id}:${incoming.messageId}`);
    }
  }
});

test('a fallback-only pending reply derives ownership from the requested Agent identity', () => {
  const incoming = request('incoming-ios', peer, Date.now());
  for (const viewer of [owner, peer]) {
    const projected = conversation(viewer, [incoming]);
    projected.messages = projected.messages.filter(message => message.deliveryState !== 'processing');
    const view = mapCollaborationConversationToViewModel(projected, undefined, 'Target Agent');
    const pending = view.messages.filter(message => message.turn && !message.turn.completed);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].role, viewer === owner ? 'owned-agent' : 'external-agent');
    assert.equal(pending[0].senderOwnerName ?? (pending[0].role === 'owned-agent' ? 'You' : null), viewer === owner ? 'You' : 'Owner');
  }
});

test('concurrent identical requests stay separate and completion removes only its own pending reply', () => {
  const now = Date.now();
  const first = request('first', peer, now - 1000);
  const second = request('second', peer, now);
  const pendingView = mapCollaborationConversationToViewModel(conversation(owner, [first, second]), undefined, 'Target Agent');
  assert.equal(pendingView.messages.filter(message => message.turn && !message.turn.completed).length, 2);
  const fallback = conversation(owner, [first, second]);
  fallback.messages = fallback.messages.filter(message => message.requestId !== second.messageId || message.deliveryState !== 'processing');
  const fallbackView = mapCollaborationConversationToViewModel(fallback, undefined, 'Target Agent');
  assert.equal(fallbackView.messages.filter(message => message.turn && !message.turn.completed).length, 2);
  const response = { ...second, messageId: 'answer', fromAccountId: owner.accountId, toAccountId: peer.accountId,
    body: encodeCloudAgentResponse({ requestId: second.messageId, text: 'Weather checked.', deliveryState: 'complete' }) };
  const projected = conversation(owner, [first, second, response]);
  const view = mapCollaborationConversationToViewModel(projected, undefined, 'Target Agent');
  const pending = view.messages.filter(message => message.turn && !message.turn.completed);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].replyToMessageId, `collaboration-message:${projected.id}:${first.messageId}`);
  assert.equal(view.messages.filter(message => message.turn?.assistantText === 'Weather checked.').length, 1);
});

test('completed outreach metadata does not hide a newer outgoing pending request', () => {
  const incoming = request('new-request', owner, Date.now());
  const projected = conversation(owner, [incoming]);
  projected.outreach = { ...projected.outreach!, sourceRequestId: 'old-request', status: 'completed' };
  const view = mapCollaborationConversationToViewModel(projected, undefined, 'Target Agent');
  assert.equal(view.messages.filter(message => message.turn && !message.turn.completed).length, 1);
});
