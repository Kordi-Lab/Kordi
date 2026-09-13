import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalSessionState, CanonicalSessionMessage } from '../src/kordi-app/types';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { persistCloudSelfAgentCanonicalSyncPlan } from '../src/features/cloud/cloudSelfAgentCanonicalSyncExecution';
import { mergeCloudSelfAgentCanonicalSyncBatch } from '../src/features/cloud/cloudCanonicalStateMerge';
import { CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND, encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { applySessionAgentIdentity } from '../src/features/canonical/readModel/conversationMapping';
import { cloudSyncedLocalAgentSessionIds } from '../src/features/cloud/cloudSelfAgentSessionIdentity';

const account = { accountId: 'owner', displayName: 'Owner' } as CloudAccount;
const owner = { id: 'human:owner', kind: 'human' as const, humanId: 'owner', displayName: 'Owner', source: 'local' as const, createdAtMs: 1, updatedAtMs: 1 };
const defaultAgent = { id: 'agent:cloud-self:owner', kind: 'agent' as const, agentId: 'cloud-agent:owner', ownerIdentityId: owner.id, displayName: 'Default Agent', source: 'local' as const, createdAtMs: 1, updatedAtMs: 1 };
function state(): CanonicalSessionState {
  return { profile: { humanIdentityId: owner.id }, identities: [owner, defaultAgent], sessions: [], messages: [], participants: [], delegatedExchanges: [] } as unknown as CanonicalSessionState;
}
function request(sessionId: string, agentId = 'cloud_agent_research', ownerId = 'owner'): CloudMessage {
  return { messageId: `request-${sessionId}`, sessionId, fromAccountId: 'owner', toAccountId: 'owner',
    createdAt: '2026-09-13T10:00:00Z', direction: 'outgoing', deliveredAt: null, readAt: null,
    body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'Hello',
      targetCloudAgentId: agentId, targetCloudAgentName: 'Research Agent', targetCloudAgentOwnerAccountId: ownerId }) };
}
function response(message: CloudMessage): CloudMessage {
  return { ...message, messageId: `reply-${message.messageId}`, createdAt: '2026-09-13T10:00:01Z',
    body: encodeCloudAgentResponse({ requestId: message.messageId, text: 'Hello back', deliveryState: 'complete' }) };
}
async function apply(input: CanonicalSessionState, messages: CloudMessage[], durableSourceEventIds?: Set<string>) {
  const plan = planCloudSelfAgentCanonicalSync({ account, agentDisplayName: 'Default Agent', state: input, messages, durableSourceEventIds });
  const knownIdentities = new Set(input.identities.map(identity => identity.id));
  const batch = await persistCloudSelfAgentCanonicalSyncPlan(plan, { persistence: {
    upsertIdentity: async identity => {
      knownIdentities.add(identity.id!);
      return { ...identity, createdAtMs: 1, updatedAtMs: 1 } as CanonicalSessionState['identities'][number];
    },
    openSession: async session => {
      assert(knownIdentities.has(session.primaryIdentityId!), 'Persist the target before its session');
      return { session: { ...session, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 }, participants: [] } as never;
    },
    upsertMessage: async message => ({ ...message, sequenceNum: 1, updatedAtMs: 1 } as CanonicalSessionMessage),
    reconcileMessageMirror: async () => true,
  } });
  assert(batch);
  return { plan, next: mergeCloudSelfAgentCanonicalSyncBatch(input, batch)! };
}

test('an iOS-created custom Agent session preserves its own identity through persistence and rendering', async () => {
  const req = request('custom-session');
  const { next } = await apply(state(), [req, response(req)]);
  const session = next.sessions[0];
  assert.equal(session.kind, 'direct-agent');
  const identity = next.identities.find(value => value.id === session.primaryIdentityId)!;
  assert.equal(identity.agentId, 'cloud_agent_research');
  assert.equal(identity.displayName, 'Research Agent');
  const answer = next.messages.find(message => message.senderRole === 'owned-agent')!;
  assert.equal(answer.senderIdentityId, identity.id);
  assert.equal(mapCanonicalMessage(answer, new Map(next.identities.map(value => [value.id, value])), owner.id)?.sender, 'Research Agent');
  assert(cloudSyncedLocalAgentSessionIds(next).has(session.id), 'Mac replies must continue syncing after identity restoration');
  const native = { ...answer, senderIdentityId: defaultAgent.id, content: { sender: 'Default Agent' } };
  assert.equal(mapCanonicalMessage(applySessionAgentIdentity(session, native), new Map(next.identities.map(value => [value.id, value])), owner.id)?.sender, 'Research Agent');
  const replay = await apply(next, [req, response(req)], new Set([req.messageId, response(req).messageId]));
  assert.equal(replay.plan.sessionRequests.length, 0);
  assert.equal(replay.plan.messageRequests.length, 0);
  assert.equal(replay.plan.targetIdentityRequests?.length, 0);
});

test('already persisted default attribution is repaired without duplicating history or affecting another session', async () => {
  const req = request('custom-session');
  const old = await apply(state(), [{ ...req, body: 'Hello' }, response(req)]);
  const defaultReq = request('default-session', 'cloud-agent:owner');
  const input = (await apply(old.next, [defaultReq, response(defaultReq)])).next;
  const { next } = await apply(input, [req, response(req)], new Set([req.messageId, response(req).messageId]));
  assert.equal(next.messages.length, input.messages.length);
  const target = next.sessions.find(session => session.id === req.sessionId)!;
  assert.notEqual(target.primaryIdentityId, defaultAgent.id);
  assert.equal(next.messages.find(message => message.sessionId === req.sessionId && message.senderRole === 'owned-agent')?.senderIdentityId, target.primaryIdentityId);
  assert.equal(next.sessions.find(session => session.id === defaultReq.sessionId)?.primaryIdentityId, defaultAgent.id);
});

test('a mismatched owner cannot replace the local Agent identity', async () => {
  const req = request('foreign-target', 'cloud_agent_foreign', 'someone-else');
  const { plan } = await apply(state(), [req, response(req)]);
  assert.equal(plan.targetIdentityRequests?.length, 0);
  assert.equal(plan.sessionRequests[0].primaryIdentityId, defaultAgent.id);
});


test('a later default identity marker cannot overwrite the explicit iOS Agent target', async () => {
  const req = request('custom-session');
  const staleMarker = { ...request('custom-session', 'cloud-agent:owner'), messageId: 'legacy-identity-marker',
    messageKind: CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND, createdAt: '2026-09-13T10:00:02Z' };
  const { next } = await apply(state(), [req, response(req), staleMarker]);
  assert.equal(next.identities.find(identity => identity.id === next.sessions[0].primaryIdentityId)?.displayName, 'Research Agent');
  assert.notEqual(next.sessions[0].primaryIdentityId, defaultAgent.id);
});
