import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldUseCloudSessionAction } from '../src/app/useKordiAppModelHelpers';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import {
  canonicalNoProviderFailedAgentMessageRequest,
} from '../src/features/chat/messageActions/chatMessages';
import { shouldUseNoProviderSelfAgentShortcut } from '../src/features/chat/messageActions/localAgentSessionTarget';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import { readKordiAppModelImplementationSource } from './helpers/appModelSource';

const cloudAgentAvailabilitySource = () => readFileSync(new URL('../src/features/cloud/useCloudAgentAvailability.ts', import.meta.url), 'utf8');
const cloudAgentRequestStateSource = () => readFileSync(new URL('../src/features/cloud/cloudAgentRequestState.ts', import.meta.url), 'utf8');
const cloudGroupAgentControlSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupAgentControl.ts', import.meta.url), 'utf8');
const cloudGroupAgentExecutionSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupAgentExecution.ts', import.meta.url), 'utf8');
const cloudGroupAgentPolicySource = () => readFileSync(new URL('../src/features/cloud/cloudGroupAgentPolicy.ts', import.meta.url), 'utf8');
const cloudGroupAgentPublicationSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupAgentPublication.ts', import.meta.url), 'utf8');
const cloudGroupAgentFailureSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupAgentFailure.ts', import.meta.url), 'utf8');
const cloudGroupMessageControlSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupMessageControl.ts', import.meta.url), 'utf8');
const cloudGroupControlSenderSource = () => readFileSync(new URL('../src/features/cloud/useCloudGroupControlSender.ts', import.meta.url), 'utf8');

test('shouldUseCloudSessionAction routes canonical cloud session ids but leaves local runtime ids alone', () => {
  assert.equal(shouldUseCloudSessionAction('session:direct-person:acct_a:acct_b'), true);
  assert.equal(shouldUseCloudSessionAction('session:group:abc'), true);
  assert.equal(shouldUseCloudSessionAction('bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldUseCloudSessionAction('550e8400-e29b-41d4-a716-446655440000'), false);
});

test('cloud remove archives matching local canonical sessions after server removal succeeds', () => {
  const source = readFileSync(new URL('../src/app/useKordiChatSessionActions.ts', import.meta.url), 'utf8');
  const deleteBranchStart = source.indexOf('if (shouldUseCloudSessionAction(trimmedSessionId)) {', source.indexOf('const deleteSession'));
  const deleteBranchEnd = source.indexOf('} catch (error) {', deleteBranchStart);
  const cloudDeleteBranch = source.slice(deleteBranchStart, deleteBranchEnd);
  assert.match(cloudDeleteBranch, /await deleteCloudSession\(trimmedSessionId\);[\s\S]*archiveDesktopChatSession\(\s*trimmedSessionId,\s*desktopActiveSessionId/);
});

test('local cloud self-agent no-provider errors become failed agent replies in canonical chat', () => {
  const state: CanonicalSessionState = {
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session-cloud-self', kind: 'self-agent', title: 'My agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { cloudSelfAgentSession: true }, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const request = canonicalNoProviderFailedAgentMessageRequest({
    state,
    sessionId: 'session-cloud-self',
    requestMessageId: 'msg:user:1',
    now: 123,
  });

  assert.equal(request?.senderIdentityId, 'agent:me');
  assert.equal(request?.senderRole, 'owned-agent');
  assert.equal(request?.messageKind, 'agent-turn');
  assert.equal(request?.status, 'failed');
  assert.equal(request?.parentMessageId, 'msg:user:1');
  assert.equal((request?.content as Record<string, unknown>).deliveryState, 'failed');
  assert.match(String((request?.content as Record<string, unknown>).error), /No provider configured yet/);
});

test('canonical quoted human messages map source metadata for transcript rendering', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
  ]);
  const mapped = mapCanonicalMessage({
    id: 'msg:reply',
    sessionId: 'session:one',
    senderIdentityId: 'human:me',
    senderRole: 'user',
    messageKind: 'text',
    contentText: 'Yes',
    content: {
      sender: 'Me',
      timeLabel: '10:43',
      replyToMessageId: 'msg:source',
      messageAction: {
        schemaVersion: 1,
        kind: 'quote',
        source: {
          sourceSessionId: 'session:one',
          sourceMessageId: 'msg:source',
          senderLabel: 'Alice',
          textPreview: 'Original question',
          attachmentCount: 0,
          timeLabel: '10:42',
        },
      },
    },
    parentMessageId: 'msg:source',
    delegatedExchangeId: null,
    status: 'sent',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    contentHash: null,
    sourceTransport: 'desktop-chat-ui',
    sourceEventId: 'desktop-chat-ui:session:one:2',
  }, identityById, 'human:me');

  assert.equal(mapped?.replyToMessageId, 'msg:source');
  assert.equal(mapped?.messageAction?.kind, 'quote');
  assert.equal(mapped?.sourceMessage?.messageId, 'msg:source');
  assert.equal(mapped?.sourceMessage?.senderLabel, 'Alice');
  assert.equal(mapped?.sourceMessage?.text, 'Original question');
});


test('hosted cloud agent responses render the selected agent name without owner possessives', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
    ['human:333', { id: 'human:333', kind: 'human' as const, displayName: '333', ownerIdentityId: null, source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_333', humanId: 'acct_333', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
    ['agent:cloud:333', { id: 'agent:cloud:333', kind: 'agent' as const, displayName: 'Kordi Project Driver', ownerIdentityId: 'human:333', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_333', humanId: null, agentId: 'cloud_agent_project', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
  ]);
  const mapped = mapCanonicalMessage({
    id: 'msg:cloud-agent-final',
    sessionId: 'session:direct-person:acct_me:acct_333',
    senderIdentityId: 'agent:cloud:333',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'Here is the plan.',
    content: { sender: 'Kordi Project Driver', deliveryState: 'complete', requestId: 'msg:request', replyToMessageId: 'msg:request', cloudGroupMessageId: 'msg:cloud-agent:terminal' },
    parentMessageId: 'msg:request',
    delegatedExchangeId: null,
    status: 'complete',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:final',
  }, identityById, 'human:me');

  assert.equal(mapped?.sender, 'Kordi Project Driver');
  assert.doesNotMatch(mapped?.sender ?? '', /333['’]s/);
  assert.deepEqual(mapped?.replyAliasIds, ['msg:request', 'msg:cloud-agent:terminal']);
});

test('cloud fallback runtime failures render as normal failed agent turns with concise copy', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
    ['agent:me', { id: 'agent:me', kind: 'agent' as const, displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
  ]);
  const mapped = mapCanonicalMessage({
    id: 'msg:cloud-fallback-failed',
    sessionId: 'session-cloud-self',
    senderIdentityId: 'agent:me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: { deliveryState: 'failed', error: 'Cloud fallback cannot run because the owner has not enabled a provider-auth snapshot.' },
    parentMessageId: 'msg:user',
    delegatedExchangeId: null,
    status: 'failed',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:failed',
  }, identityById, 'human:me');

  assert.equal(mapped?.turn?.status, 'failed');
  assert.equal(mapped?.turn?.assistantText, '');
  assert.equal(mapped?.turn?.error, 'Provider auth is not synced for Cloud fallback yet. Open this device once to sync provider access.');
});

test('imported desktop no-provider agent messages render as failed red replies', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
    ['agent:me', { id: 'agent:me', kind: 'agent' as const, displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
  ]);
  const mapped = mapCanonicalMessage({
    id: 'msg:error',
    sessionId: 'session-cloud-self',
    senderIdentityId: 'agent:me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'No OpenAI credentials are available. Add OPENAI_API_KEY or sign in with ChatGPT account access.',
    content: { sender: 'Kordi', timeLabel: '21:02', detail: 'openai/gpt-5.4 • error' },
    parentMessageId: 'msg:user',
    delegatedExchangeId: null,
    status: 'complete',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    contentHash: null,
    sourceTransport: 'desktop-chat',
    sourceEventId: 'desktop-chat:error',
  }, identityById, 'human:me');

  assert.equal(mapped?.turn?.status, 'failed');
  assert.equal(mapped?.turn?.assistantText, '');
  assert.match(mapped?.turn?.error ?? '', /No OpenAI credentials/);
});

test('cloud self-agent sends with no configured auth skip local runtime to avoid no-provider flicker', () => {
  const source = readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
  const shortcutIndex = source.indexOf('shouldUseNoProviderSelfAgentShortcut({');
  const runtimeCreateIndex = source.indexOf('materializedState = await createDesktopChatSession()');
  assert.ok(shortcutIndex >= 0 && runtimeCreateIndex > shortcutIndex, 'no-provider shortcut must run before desktop runtime session creation');
  assert.match(source.slice(shortcutIndex, runtimeCreateIndex), /window\.setTimeout\(\(\) => \{/);


  const state = {
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [],
    sessions: [
      { id: 'session-cloud-self', kind: 'self-agent', title: 'My agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { cloudSelfAgentSession: true }, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as CanonicalSessionState;

  assert.equal(shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesCollaborationRouting: false,
    activeConvCanonicalSessionId: 'session-cloud-self',
    canonicalSessionState: state,
    hasAnyDesktopAuth: false,
  }), true);
  assert.equal(shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesCollaborationRouting: false,
    activeConvCanonicalSessionId: null,
    canonicalSessionState: state,
    hasAnyDesktopAuth: false,
  }), true);
  assert.equal(shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesCollaborationRouting: false,
    activeConvCanonicalSessionId: 'session-cloud-self',
    canonicalSessionState: state,
    hasAnyDesktopAuth: true,
  }), false);
});

test('synthetic no-provider replies suppress duplicate imported desktop runtime failures', () => {
  const baseState: CanonicalSessionState = {
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session-cloud-self', kind: 'self-agent', title: 'My agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [
      { id: 'msg:user', sessionId: 'session-cloud-self', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', content: {}, parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-chat:user' },
      { id: 'msg:runtime-error', sessionId: 'session-cloud-self', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'No OpenAI credentials are available. Add OPENAI_API_KEY or sign in with ChatGPT account access.', content: { replyToMessageId: 'msg:user' }, parentMessageId: 'msg:user', delegatedExchangeId: null, status: 'complete', sequenceNum: 2, createdAtMs: 11, updatedAtMs: 11, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-chat:error' },
      { id: 'msg:no-provider:msg:user', sessionId: 'session-cloud-self', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { deliveryState: 'failed', error: 'No provider configured yet.', replyToMessageId: 'msg:user', requestId: 'msg:user' }, parentMessageId: 'msg:user', delegatedExchangeId: null, status: 'failed', sequenceNum: 3, createdAtMs: 12, updatedAtMs: 12, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-chat-ui-no-provider:session-cloud-self:msg:user' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const messages = buildCanonicalIndexes(baseState).canonicalMessagesBySessionId.get('session-cloud-self') ?? [];
  assert.equal(messages.filter((message) => message.role === 'owned-agent').length, 1);
  assert.equal(messages.find((message) => message.role === 'owned-agent')?.turn?.error, 'No provider configured yet.');
});

test('Cloud self-agent reconciliation hides the local mirror and obsolete no-provider failure', () => {
  const sessionId = 'session:self-agent:reconciled';
  const state: CanonicalSessionState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'My Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, sourceIdentityId: null, humanId: null, agentId: 'cloud-self:acct_me', avatarKey: null, profileImageUrl: null, metadata: { cloudSelfAgent: true }, createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'self-agent', title: 'My Kordi', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { cloudSelfAgentSession: true }, createdAtMs: 1, updatedAtMs: 12 },
    ],
    participants: [],
    messages: [
      { id: 'msg:user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'test', content: {}, parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-chat-ui:user' },
      { id: 'msg:no-provider:msg:user', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { deliveryState: 'failed', error: 'No provider configured yet.', requestId: 'msg:user', replyToMessageId: 'msg:user' }, parentMessageId: 'msg:user', delegatedExchangeId: null, status: 'failed', sequenceNum: 2, createdAtMs: 11, updatedAtMs: 11, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-chat-ui-no-provider:msg:user' },
      { id: 'msg:cloud:self:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'test', content: {}, parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 3, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-request' },
      { id: 'msg:cloud:self:response', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Received.', content: { cloudRequestMessageId: 'cloud-request' }, parentMessageId: 'msg:user', delegatedExchangeId: null, status: 'complete', sequenceNum: 4, createdAtMs: 12, updatedAtMs: 12, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const messages = buildCanonicalIndexes(state).canonicalMessagesBySessionId.get(sessionId) ?? [];
  assert.deepEqual(messages.map((message) => message.id), ['msg:user', 'msg:cloud:self:response']);
});

test('cloud group read state is driven by cloud metadata, not transient local unread increments', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /incrementLocalSessionUnread\?\.\(envelope\.groupId/);
});

test('cloud group requesting placeholder times out to unavailable notice instead of misleading auth copy', () => {
  const source = cloudAgentAvailabilitySource();
  const stateSource = cloudAgentRequestStateSource();
  assert.match(source, /CLOUD_GROUP_AGENT_STATUS_RECHECK_MS = 5_000/);
  assert.match(source, /CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS = 2 \* 60_000/);
  const timeoutIndex = source.indexOf('const requestDeadlineMs = candidate.requestMessage.createdAtMs');
  assert.ok(timeoutIndex >= 0, 'expected bounded requesting placeholder status checks');
  const timeoutBlock = source.slice(timeoutIndex, timeoutIndex + 6500);
  assert.match(timeoutBlock, /cloudFallbackRunAlreadyOwnsRequest\(\{/);
  assert.match(timeoutBlock, /cloudFallbackRunClaimsForMessages\(\{/);
  assert.match(timeoutBlock, /claimCloudFallbackRun\(\s*exactClaim/);
  assert.match(timeoutBlock, /scheduleStatusCheck\(\s*Math\.min\(\s*CLOUD_GROUP_AGENT_STATUS_RECHECK_MS,\s*remainingMs,?\s*\),?\s*\)/);
  assert.match(timeoutBlock, /cloudGroupAgentUnavailableFallbackRequest\(\{/);
  assert.match(stateSource, /CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE/);
  assert.match(stateSource, /`cloud-group-agent-unavailable-timeout:/);
  assert.match(stateSource, /status:\s*'failed'/);
  assert.match(stateSource, /sourceTransport:\s*'cloud-group-agent-offline'/);
});

test('fresh group sends claim fallback before waiting for a background Cloud sync', () => {
  const source = cloudGroupControlSenderSource();
  const outboxBlockStart = source.indexOf('const sentMessages: CloudMessage[] = [];');
  const outboxBlock = source.slice(outboxBlockStart, outboxBlockStart + 3200);
  assert.match(outboxBlock, /await Promise\.all\(\[[\s\S]*claimFreshFallback\(\s*sentMessages,\s*canonicalMessageId,\s*session\.token,?\s*\),[\s\S]*syncDiff/);
  const directSendBlockStart = source.indexOf('const sent = fulfilledCloudGroupSends(results);', outboxBlockStart);
  const directSendBlock = source.slice(directSendBlockStart, directSendBlockStart + 1800);
  assert.match(directSendBlock, /await Promise\.all\(\[[\s\S]*claimFreshFallback\(\s*sent,\s*canonicalMessageId,\s*session\.token,?\s*\),[\s\S]*syncDiff/);
});

test('adding existing group members publishes Cloud authorization before the local batch commit', () => {
  const handler = readFileSync(
    new URL('../src/app/useKordiGroupMemberInvites.ts', import.meta.url),
    'utf8',
  );
  const inviteIndex = handler.indexOf('await publishCloudGroupInvites');
  const commitIndex = handler.indexOf('await addCanonicalGroupMembersFast');
  assert.ok(inviteIndex >= 0, 'expected Cloud invite publication');
  assert.ok(commitIndex > inviteIndex, 'expected local membership commit after Cloud invite acknowledgement');
  assert.match(handler, /await Promise\.all\(groupSessionIds\.map/);
  assert.match(handler, /memberJoins: cloudMemberJoins/);
  assert.match(handler, /joinEvents: joinEvents\.map/);
  assert.doesNotMatch(handler, /await addCanonicalSessionParticipants/);
  assert.doesNotMatch(handler, /nextState = await updateCanonicalSessionMetadata/);
});

test('cloud group hosted-agent sends render processing in the final response slot', () => {
  const source = cloudAgentAvailabilitySource();
  assert.match(source, /msg:cloud-agent-processing:\$\{candidate\.requestMessage\.id\}[\s\S]*\$\{candidate\.targetAccountId\}/);
  assert.match(source, /setCanonicalSessionState\(\(current\) =>\s*upsertCanonicalRequestIntoLocalState\(\s*appendCloudGroupRequestingPlaceholder\(current, candidate, noticeId\),\s*requestingNoticeRequest,\s*\)\s*\);/);
  assert.match(source, /void upsertCanonicalMessageFast\(requestingNoticeRequest\)/);
});

test('cloud group owner processing upserts the shared slot so a local placeholder cannot block broadcast', () => {
  const source = `${cloudGroupAgentExecutionSource()}\n${cloudGroupAgentPublicationSource()}`;
  const processingMessageIdIndex = source.indexOf(
    '`msg:cloud-agent-processing:${message.id}:${account.accountId}`',
  );
  assert.ok(processingMessageIdIndex >= 0, 'expected owner cloud group processing slot');
  const processingBlock = source.slice(processingMessageIdIndex);
  assert.match(processingBlock, /await upsertCanonicalMessageFast\(\s*processingRequest,?\s*\)/);
  assert.match(processingBlock, /mergeCanonicalMessageRow\(\s*current,\s*persistedProcessingMessage,?\s*\)/);
  assert.doesNotMatch(processingBlock, /await (?:append|upsert)CanonicalMessage\(\{/);
  assert.match(processingBlock, /sourceTransport:\s*'cloud-group-agent'/);
  assert.match(processingBlock, /targetAccountIds\.map\(\(targetAccountId\) => \([\s\S]*runtime\.client\.sendMessage/);
});

test('cloud group terminal hosted-agent responses reserve the stable slot even when processing is not visible yet', () => {
  const source = cloudGroupMessageControlSource();
  assert.match(source, /terminalStableAgentNoticeId/);
  assert.match(source, /replacementAgentSlot\?\.id \?\? terminalStableAgentNoticeId \?\? message\.id/);
  assert.match(source, /existingStableRowTerminalLocked[\s\S]*existingStableRowDeliveryState/);
  assert.match(source, /cloudGroupMessageId:\s*message\.id/);
  assert.match(cloudGroupAgentExecutionSource(), /cloudGroupMessageId:\s*responseMessageId/);
});

test('cloud group terminal hosted-agent responses clear timeout placeholders and keep agent attribution', () => {
  const stateSource = cloudAgentRequestStateSource();
  const agentSource = cloudGroupAgentExecutionSource();
  assert.match(stateSource, /removeCloudGroupPendingRowsForTerminalResponse/);
  assert.match(stateSource, /cloudGroupPendingAgentRowMatches/);
  assert.match(stateSource, /cloud-group-agent-unavailable-timeout:/);
  assert.match(agentSource, /sender: presentation\.displayName/);
  assert.doesNotMatch(agentSource, /sender:\s*'My Kordi'/);
});

test('cloud group hosted-agent metadata targets the owner runtime even when text is not My Kordi', () => {
  const stateSource = cloudGroupAgentPolicySource();
  const agentSource = `${cloudGroupAgentControlSource()}\n${cloudGroupAgentExecutionSource()}`;
  assert.match(stateSource, /export function cloudGroupMessageTargetsLocalAgent/);
  assert.match(stateSource, /cloudMessageActionAllowsAgentTrigger\(message\.messageAction\)/);
  assert.match(stateSource, /cleanCloudText\(message\.targetCloudAgentOwnerAccountId\)[\s\S]*?=== account\.accountId/);
  assert.match(stateSource, /cleanCloudText\(message\.targetCloudAgentId\)[\s\S]*?\.startsWith\('cloud_agent_'\)/);
  assert.match(stateSource, /targetsOwnedHostedCloudAgent \|\| cloudMessageMentionsLocalAgent/);
  assert.match(agentSource, /policy\.messageTargetsLocalAgent\([\s\S]*message,[\s\S]*account,[\s\S]*envelope\.participants/);
  assert.match(cloudGroupAgentControlSource(), /targetDefinition\.accessScope !== 'participant_conversations'/);
  assert.doesNotMatch(cloudGroupAgentControlSource(), /\|\|\s*senderIsAgent/);
  assert.match(agentSource, /targetCloudAgentId: effectiveTargetCloudAgentId/);
});

test('cloud group no-provider catch broadcasts a failed agent response to requesters', () => {
  const source = cloudGroupAgentFailureSource();
  assert.match(source, /isCloudAgentNoProviderConfiguredError\(error\)/);
  assert.match(source, /encodeCloudGroupControl\(\{/);
  assert.match(source, /deliveryState:\s*'failed'/);
  assert.match(source, /runtime\.client\.sendMessage/);
});

test('cloud removed sessions are included in workspace hidden ids for restored canonical self-agent forks', () => {
  const source = readKordiAppModelImplementationSource();
  assert.match(source, /const combinedHiddenSessionIds = useMemo\([\s\S]*cloudDeletedSessionIds/);
  assert.match(source, /hiddenSessionIds: combinedHiddenSessionIds,/);
});
