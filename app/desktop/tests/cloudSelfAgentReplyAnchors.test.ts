import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { selfAgentMirrorDuplicateIds } from '../src/features/canonical/readModel/selfAgentMirrorDedup';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { cloudSelfAgentResponseClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';

const account: CloudAccount = { accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.com', avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true };
function request(overrides: Partial<CanonicalSessionMessage> = {}) {
  return { id: 'local-request', sessionId: 'project-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', status: 'sent', sequenceNum: 1, createdAtMs: 200, updatedAtMs: 200, sourceTransport: 'desktop-chat-ui', content: {}, ...overrides } as CanonicalSessionMessage;
}

test('a project transcript keeps the published reply when native history still contains its raw echo', () => {
  const original = request({ content: { desktopEntryId: 'wire-request' } });
  const published = { ...original, id: 'cloud-final', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Published reply', content: { cloudRequestMessageId: 'wire-request' }, status: 'complete', sourceTransport: 'cloud-self-agent', parentMessageId: original.id, sequenceNum: 2, createdAtMs: 201 } as CanonicalSessionMessage;
  const raw = { ...published, id: 'native-reply', sourceTransport: 'desktop-chat', contentText: 'Raw local result', content: { desktopEntryId: 'native-entry' }, sequenceNum: 3 };
  const canonical = { ...state([original, published, raw]), storagePath: '/fixture/canonical', delegatedExchanges: [], presence: [], contextSnapshots: [],
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
  } as CanonicalSessionState;
  const identities = new Map(canonical.identities.map((identity) => [identity.id, identity]));
  const model = createCanonicalSessionReadModel(canonical);
  const native = conversation({ id: original.sessionId, canonicalSessionId: original.sessionId, type: 'owned-agent', desktopRuntimeBacked: true, desktopRuntimeTranscriptLoaded: true,
    messages: [mapCanonicalMessage(original, identities, 'human:me')!, mapCanonicalMessage(raw, identities, 'human:me')!],
  });
  const visibleText = (message: ReturnType<typeof model.messages>[number]) => message.turn?.assistantText || message.text;
  assert.deepEqual(model.messages(original.sessionId).map(visibleText), ['hello', 'Published reply']);
  assert.deepEqual(model.applyConversation(native, () => '').messages.map(visibleText), ['hello', 'Published reply']);
  const enriched = { ...published, content: { ...published.content as object, desktopEntryId: 'native-entry' } };
  const afterAliasMerge = createCanonicalSessionReadModel({ ...canonical, messages: [original, enriched] });
  assert.deepEqual(afterAliasMerge.applyConversation(native, () => '').messages.map(visibleText), ['hello', 'Published reply'], 'The native echo stays suppressed after canonical aliases converge');
  const later = request({ id: 'later-request', contentText: 'Later question', createdAtMs: 300, sequenceNum: 3 });
  const migrated = createCanonicalSessionReadModel({ ...canonical, messages: [original, later, { ...enriched, createdAtMs: 500 }] });
  assert.deepEqual(migrated.messages(original.sessionId).map(visibleText), ['hello', 'Published reply', 'Later question'], 'Restored reply links determine turn placement even when an old timestamp is immutable');
});
function state(messages: CanonicalSessionMessage[]) {
  return { sessions: [{ id: 'project-session', kind: 'project', title: 'Task', status: 'active' }], identities: [], participants: [], messages, profile: { humanIdentityId: 'human:me' } } as unknown as CanonicalSessionState;
}
const reply: CloudMessage = {
  messageId: 'wire-reply', sessionId: 'project-session', fromAccountId: 'acct_me', toAccountId: 'acct_me',
  body: encodeCloudAgentResponse({ requestId: 'wire-request', text: 'Hello back', deliveryState: 'complete' }),
  createdAt: new Date(500).toISOString(), deliveredAt: null, readAt: null,
};

for (const identity of ['forward-ledger', 'native-alias', 'cloud-source'] as const) {
  test(`a reply links to its earlier request when the request is absent from this history page (${identity})`, () => {
    const earlier = request(identity === 'native-alias' ? { content: { desktopEntryId: 'wire-request' } }
      : identity === 'cloud-source' ? { sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-request' } : {});
    const plan = planCloudSelfAgentCanonicalSync({ account, state: state([earlier, request({ id: 'later-request', createdAtMs: 300 })]), messages: [reply],
      requestSyncLedger: identity === 'forward-ledger' ? { 'local-request': { cloudMessageId: 'wire-request', syncedAtMs: 250 } } : {},
    });
    assert.equal(plan.messageRequests.length, 1);
    assert.equal(plan.messageRequests[0].parentMessageId, earlier.id, 'Exact request identity must distinguish repeated greetings');
    assert.equal(plan.messageRequests[0].createdAtMs, 201);
  });
}

test('restoration repairs an already durable terminal reply that lost its request link', () => {
  const orphan = { id: 'msg:cloud:self:response:wire-request', sessionId: 'project-session', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello back', content: { cloudRequestMessageId: 'wire-request' }, status: 'complete', sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-reply', sequenceNum: 2, createdAtMs: 500, updatedAtMs: 500 } as CanonicalSessionMessage;
  const plan = planCloudSelfAgentCanonicalSync({ account, state: state([request(), orphan]), messages: [reply],
    durableSourceEventIds: new Set(['wire-reply']), requestSyncLedger: { 'local-request': { cloudMessageId: 'wire-request', syncedAtMs: 250 } },
  });
  assert.equal(plan.messageRequests.length, 1);
  assert.equal(plan.messageRequests[0].id, orphan.id);
  assert.equal(plan.messageRequests[0].parentMessageId, 'local-request');
  assert.equal(plan.messageRequests[0].createdAtMs, 201);
});

test('a durable request echo retains the local user id as the response parent', () => {
  const echo: CloudMessage = { ...reply, messageId: 'wire-request', body: 'hello', createdAt: new Date(400).toISOString(), clientMessageId: cloudSelfAgentRequestClientMessageId('project-session', 'local-request') };
  const plan = planCloudSelfAgentCanonicalSync({ account, state: state([request()]), messages: [echo, reply], durableSourceEventIds: new Set(['wire-request']) });
  assert.equal(plan.messageRequests[0].parentMessageId, 'local-request');
  assert.equal(plan.messageRequests[0].createdAtMs, 201, 'A delayed server echo does not change the original user timestamp');
});

test('a durable reply keeps its known parent and repairs its timestamp even without a request alias', () => {
  const response = { id: 'msg:cloud:self:response:wire-request', sessionId: 'project-session', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello back', content: { cloudRequestMessageId: 'wire-request' }, status: 'complete', sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-reply', parentMessageId: 'local-request', sequenceNum: 2, createdAtMs: 500, updatedAtMs: 500 } as CanonicalSessionMessage;
  const plan = planCloudSelfAgentCanonicalSync({ account, state: state([request(), response]), messages: [reply], durableSourceEventIds: new Set(['wire-reply']) });
  assert.equal(plan.messageRequests.length, 1);
  assert.equal(plan.messageRequests[0].id, response.id);
  assert.equal(plan.messageRequests[0].parentMessageId, response.parentMessageId);
  assert.equal(plan.messageRequests[0].createdAtMs, 201);
});

test('a native request mirror cannot displace the original user bubble as the reply anchor', () => {
  const original = request({ content: { desktopEntryId: 'wire-request' } });
  const nativeCopy = request({ id: 'native-copy', sourceTransport: 'desktop-chat', createdAtMs: 450, content: { desktopEntryId: 'wire-request' } });
  const plan = planCloudSelfAgentCanonicalSync({ account, state: state([original, nativeCopy]), messages: [reply] });
  assert.equal(plan.messageRequests[0].parentMessageId, original.id);
  assert.equal(plan.messageRequests[0].createdAtMs, 201);
});

test('a stale native reply client id cannot replace the reply to a different exact request', () => {
  const first = request({ id: 'first-request', content: { desktopEntryId: 'first-wire' } });
  const second = request({ content: { desktopEntryId: 'wire-request' } });
  const raw = { ...second, id: 'native-reply', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello back', parentMessageId: first.id, sourceTransport: 'desktop-chat', status: 'complete' } as CanonicalSessionMessage;
  const published = { ...raw, id: 'msg:cloud:self:response:wire-request', sourceTransport: 'cloud-self-agent', sourceEventId: reply.messageId, parentMessageId: null, content: { cloudRequestMessageId: 'wire-request' } };
  const plan = planCloudSelfAgentCanonicalSync({ account, state: state([first, second, raw, published]), messages: [{ ...reply, clientMessageId: cloudSelfAgentResponseClientMessageId(first.sessionId, first.id) }] });
  assert.equal(plan.messageRequests[0].id, published.id);
  assert.equal(plan.messageRequests[0].parentMessageId, second.id);
  assert.equal(plan.mirrorReconciliations.length, 0);
  const duplicates = selfAgentMirrorDuplicateIds([first, second, raw, { ...published, parentMessageId: second.id }], new Map(), 'human:me', true);
  assert.ok(!duplicates.has(published.id), 'Equal answers to different proven requests remain separate');
});

for (const rawText of ['Raw local result', 'Published reply']) {
test(`a completed leased reply hides its raw native echo (${rawText}) while preserving unrelated turns`, () => {
  const original = request({ content: { desktopEntryId: 'wire-request' } });
  const authoritative = { id: 'cloud-final', sessionId: 'project-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Published reply', content: { cloudRequestMessageId: 'wire-request' }, status: 'complete', sourceTransport: 'cloud-self-agent', sequenceNum: 2, createdAtMs: 201, updatedAtMs: 500, parentMessageId: original.id } as CanonicalSessionMessage;
  const echo = { ...authoritative, id: 'native-reply', sourceTransport: 'desktop-chat', contentText: rawText, content: {}, parentMessageId: original.id };
  const otherRequest = request({ id: 'other-request', content: { desktopEntryId: 'other-wire-request' } });
  const otherReply = { ...echo, id: 'other-reply', parentMessageId: otherRequest.id };
  const differentSessionRequest = request({ id: 'different-session-request', sessionId: 'different-session', content: { desktopEntryId: 'wire-request' } });
  const differentSessionReply = { ...echo, id: 'different-session-reply', sessionId: 'different-session', parentMessageId: differentSessionRequest.id };
  const duplicates = selfAgentMirrorDuplicateIds([original, authoritative, echo, otherRequest, otherReply, differentSessionRequest, differentSessionReply], new Map(), 'human:me', true);
  assert.ok(duplicates.has(echo.id));
  assert.ok(!duplicates.has(authoritative.id));
  assert.ok(!duplicates.has(otherReply.id));
  assert.ok(!duplicates.has(differentSessionReply.id));
});
}
