import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_EXCHANGE_WAITING, AGENT_EXCHANGE_SILENT, isAgentExchangeControlText } from '../src/features/cloud/agentExchangeOutcome';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { isInternalCloudAgentControlMessage } from '../src/features/canonical/readModel/messageVisibility';
import { withLiveTurn } from '../src/features/cloud/cloudGroupLiveProjection';
import { buildCloudCollaborationConversation } from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import type { CanonicalSessionMessage, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

const owner: CloudAccount = { accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar, nodeId: 'owner', passwordSet: true,
  defaultAgent: { agentId: 'cloud-agent:owner', displayName: 'Target Agent', avatarUrl: null, avatar } };
const peer: CloudAccount = { ...owner, accountId: 'peer', displayName: 'Peer', nodeId: 'peer', defaultAgent: null };
const snapshot = (assistantText: string) => ({ assistantText, completed: false, succeeded: false, status: 'running', tools: [], thinkingText: '' }) as unknown as DesktopChatTurnSnapshot;

test('every streamed outcome prefix stays hidden in group live projection and history replay', () => {
  for (const full of [AGENT_EXCHANGE_WAITING, AGENT_EXCHANGE_SILENT, '{ "agentExchangeOutcome" : "waiting" }']) {
    for (let length = 1; length <= full.length; length++) {
      const text = full.slice(0, length);
      assert.equal(isAgentExchangeControlText(text, true), true);
      const row = { messageKind: 'agent-turn', senderRole: 'owned-agent', status: 'processing', contentText: '', content: {} } as CanonicalSessionMessage;
      const projected = withLiveTurn(row, snapshot(text));
      assert.equal(mapCanonicalMessage(projected, new Map()), null);
      assert.equal(mapCanonicalMessage(JSON.parse(JSON.stringify(projected)), new Map()), null);
    }
  }
  for (const text of ['', '{"answer":19}', 'Here is the result', 'Example: {"agentExchangeOutcome":"waiting"}']) {
    assert.equal(isAgentExchangeControlText(text, true), false);
  }
  assert.equal(isAgentExchangeControlText('{', false), false);
  const waiting = { messageKind: 'agent-turn', status: 'processing', contentText: '', content: { synchronizationOnly: true } } as CanonicalSessionMessage;
  const failed = { ...snapshot(''), completed: true, status: 'failed', error: 'Provider failed' };
  assert.equal(isInternalCloudAgentControlMessage(withLiveTurn(waiting, failed)), false);
});

test('direct owner overlays and peer progress never expose streaming control text or blank bubbles', () => {
  const request = { messageId: 'request', fromAccountId: owner.accountId, toAccountId: peer.accountId,
    createdAt: new Date().toISOString(), body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: '@TargetAgent ask the peer',
      targetCloudAgentId: 'cloud-agent:owner', targetCloudAgentName: 'Target Agent', targetCloudAgentOwnerAccountId: owner.accountId }) } as CloudMessage;
  for (let length = 1; length <= AGENT_EXCHANGE_WAITING.length; length++) {
    const text = AGENT_EXCHANGE_WAITING.slice(0, length);
    const progress = { ...request, messageId: 'progress', body: encodeCloudAgentResponse({ requestId: 'request', text, deliveryState: 'processing' }) };
    const parsed = parseCloudAgentResponse(progress.body)!;
    assert.equal(parsed.text, '');
    assert.equal(parsed.synchronizationOnly, true);
    for (const viewer of [owner, peer]) {
      const conversation = buildCloudCollaborationConversation({ account: viewer,
        contact: cloudContactToContact({ ...(viewer === owner ? peer : owner), createdAt: request.createdAt }),
        messages: [request, progress], runtime: 'person',
        localAgentTurnsByRequestId: viewer === owner ? { request: snapshot(text) } : {},
      });
      assert.equal(conversation.messages.length, 1);
      assert.equal(conversation.messages[0].text, '@TargetAgent ask the peer');
      assert.equal(conversation.outreach, null);
    }
  }
});

test('durable exchange status survives canonical and direct replay on the existing question', () => {
  for (const status of ['waiting', 'processing', 'completed']) {
    const text = '@Peer What is 12 + 7?';
    const row = { id: 'question', createdAtMs: 1, sessionId: 'group', senderIdentityId: 'agent', messageKind: 'agent-turn', senderRole: 'owned-agent', status: 'complete', contentText: text, content: { deliveryState: 'complete', agentExchangeStatus: status } } as CanonicalSessionMessage;
    const mapped = mapCanonicalMessage(row, new Map())!;
    assert.equal(mapped.turn?.assistantText || mapped.text, text);
    assert.equal(mapped.turn?.completed, status === 'completed');
    assert.equal(mapped.turn?.agentExchangeStatus, status === 'completed' ? undefined : status);
    const wire = { kind: 'agent-response', requestId: 'agent-exchange:synthetic:sent', text, deliveryState: 'complete', agentExchangeStatus: status };
    const question = { messageId: 'question', fromAccountId: owner.accountId, toAccountId: peer.accountId, createdAt: new Date().toISOString(), body: `kordi-cloud-agent-response:${Buffer.from(JSON.stringify(wire)).toString('base64url')}` } as CloudMessage;
    for (const viewer of [owner, peer]) {
      const conversation = buildCloudCollaborationConversation({ account: viewer, contact: cloudContactToContact({ ...(viewer === owner ? peer : owner), createdAt: question.createdAt }), messages: [question], runtime: 'person' });
      assert.equal(conversation.messages.length, 1);
      assert.equal(conversation.messages[0].text, text);
      assert.equal(conversation.messages[0].localTurn?.agentExchangeStatus, status === 'completed' ? undefined : status);
    }
  }
});
