import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldUseCloudSessionAction } from '../src/app/useKordiAppModelHelpers';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { canonicalNoProviderFailedAgentMessageRequest, shouldUseNoProviderSelfAgentShortcut } from '../src/features/chat/messageActions/chatMessages';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('shouldUseCloudSessionAction routes cloud session ids but leaves local runtime ids alone', () => {
  assert.equal(shouldUseCloudSessionAction('cloud', 'session:direct-person:acct_a:acct_b'), true);
  assert.equal(shouldUseCloudSessionAction('cloud', 'session:group:abc'), true);
  assert.equal(shouldUseCloudSessionAction('cloud', 'bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldUseCloudSessionAction('local', 'session:group:abc'), false);
  assert.equal(shouldUseCloudSessionAction('cloud', '550e8400-e29b-41d4-a716-446655440000'), false);
});

test('cloud remove archives matching local canonical sessions after server removal succeeds', () => {
  const source = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  const cloudActionBranches = source.match(/if \(shouldUseCloudSessionAction\(kordiEdition, trimmedSessionId\)\) \{[\s\S]*?return;\n      \}/g) ?? [];
  const cloudDeleteBranch = cloudActionBranches.find((branch) => branch.includes('deleteCloudSession')) ?? '';
  assert.match(cloudDeleteBranch, /await deleteCloudSession\(trimmedSessionId\);[\s\S]*archiveDesktopChatSession\(trimmedSessionId, desktopChatState\?\.activeSessionId\)/);
});

test('local cloud self-agent no-provider errors become failed agent replies in canonical chat', () => {
  const state: CanonicalSessionState = {
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session-cloud-self', kind: 'self-agent', title: 'My agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
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

test('imported desktop no-provider agent messages render as failed red replies', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
    ['agent:me', { id: 'agent:me', kind: 'agent' as const, displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
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
      { id: 'session-cloud-self', kind: 'self-agent', title: 'My agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as CanonicalSessionState;

  assert.equal(shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesBridgeRouting: false,
    activeConvCanonicalSessionId: 'session-cloud-self',
    canonicalSessionState: state,
    hasAnyDesktopAuth: false,
  }), true);
  assert.equal(shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesBridgeRouting: false,
    activeConvCanonicalSessionId: null,
    canonicalSessionState: state,
    hasAnyDesktopAuth: false,
  }), true);
  assert.equal(shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesBridgeRouting: false,
    activeConvCanonicalSessionId: 'session-cloud-self',
    canonicalSessionState: state,
    hasAnyDesktopAuth: true,
  }), false);
});

test('synthetic no-provider replies suppress duplicate imported desktop runtime failures', () => {
  const baseState: CanonicalSessionState = {
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
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

test('cloud group read state is driven by cloud metadata, not transient local unread increments', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /incrementLocalSessionUnread\?\.\(envelope\.groupId/);
});

test('cloud group requesting placeholder does not become a local no-provider error', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.match(source, /CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS/);
  const timeoutIndex = source.indexOf('window.setTimeout(() => {');
  assert.ok(timeoutIndex >= 0, 'expected requesting placeholder timeout');
  const timeoutBlock = source.slice(timeoutIndex, timeoutIndex + 900);
  assert.doesNotMatch(timeoutBlock, /cloudGroupAgentNoProviderFallbackRequest/);
  assert.match(timeoutBlock, /markCloudGroupRequestPlaceholderProcessing/);
});

test('cloud group requesting timeout refreshes server messages instead of consuming the sync cursor forever', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  const timeoutIndex = source.indexOf('window.setTimeout(() => {');
  assert.ok(timeoutIndex >= 0, 'expected requesting placeholder timeout');
  const timeoutBlock = source.slice(timeoutIndex, timeoutIndex + 900);
  assert.match(timeoutBlock, /markCloudGroupRequestPlaceholderProcessing/);
  assert.doesNotMatch(timeoutBlock, /setCloudGroupRequestPlaceholderProcessing/);
  assert.match(timeoutBlock, /refreshCloudBridgeMessages\(\)/);
});

test('late cloud group processing events cannot demote completed agent replies', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  const guardIndex = source.indexOf('const existingStableRowTerminalLocked');
  assert.ok(guardIndex >= 0, 'expected stable row terminal guard');
  const guardBlock = source.slice(Math.max(0, guardIndex - 500), guardIndex + 800);
  assert.match(guardBlock, /existingStableRowDeliveryState/);
  assert.match(guardBlock, /existingStableRowStatus !== 'processing'/);
  assert.match(guardBlock, /existingStableRowDeliveryState !== 'processing'/);
});

test('cloud group replay only marks an event processed after apply succeeds', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.match(source, /processingCloudGroupControlIdsRef/);
  assert.match(source, /\.then\(\(applied\) => \{/);
  const replayEffectIndex = source.indexOf('const replayMessages = cloudGroupControlMessagesForAccount');
  assert.ok(replayEffectIndex >= 0, 'expected cloud group replay effect');
  const replayBlock = source.slice(replayEffectIndex, replayEffectIndex + 2200);
  assert.match(replayBlock, /cloudGroupControlAlreadyMaterialized/);
  assert.match(replayBlock, /processedCloudGroupControlIdsRef\.current\.delete\(replayKey\)/);
  assert.match(replayBlock, /processingCloudGroupControlIdsRef\.current\.add\(replayKey\)/);
  assert.doesNotMatch(replayBlock, /processedCloudGroupControlIdsRef\.current\.add\(replayKey\);\s*void applyCloudGroupControl/);
  assert.match(source, /canonicalSessionState\?\.messages, initialMessagesSettled, messagesByPeer/);
});

test('cloud group no-provider catch broadcasts a failed agent response to requesters', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  const catchIndex = source.indexOf('if (isCloudAgentNoProviderConfiguredError(error)) {');
  assert.ok(catchIndex >= 0, 'expected group no-provider catch branch');
  const catchBlock = source.slice(catchIndex, source.indexOf('processedCloudAgentMentionIdsRef.current.delete(envelope.message!.id);', catchIndex));
  assert.match(catchBlock, /encodeCloudGroupControl\(\{/);
  assert.match(catchBlock, /deliveryState:\s*'failed'/);
  assert.match(catchBlock, /client\.sendMessage/);
});

test('cloud removed sessions are included in workspace hidden ids for restored canonical self-agent forks', () => {
  const source = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  assert.match(source, /const combinedHiddenSessionIds = useMemo\([\s\S]*cloudDeletedSessionIds/);
  assert.match(source, /hiddenSessionIds: combinedHiddenSessionIds,/);
});
