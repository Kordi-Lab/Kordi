import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldUseCloudSessionAction } from '../src/app/useKordiAppModelHelpers';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { canonicalNoProviderFailedAgentMessageRequest, shouldUseNoProviderSelfAgentShortcut } from '../src/features/chat/messageActions/chatMessages';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('shouldUseCloudSessionAction routes canonical cloud session ids but leaves local runtime ids alone', () => {
  assert.equal(shouldUseCloudSessionAction('session:direct-person:acct_a:acct_b'), true);
  assert.equal(shouldUseCloudSessionAction('session:group:abc'), true);
  assert.equal(shouldUseCloudSessionAction('bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldUseCloudSessionAction('550e8400-e29b-41d4-a716-446655440000'), false);
});

test('cloud remove archives matching local canonical sessions after server removal succeeds', () => {
  const source = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  const deleteBranchStart = source.indexOf('if (shouldUseCloudSessionAction(trimmedSessionId)) {', source.indexOf('const handleDeleteChatSession'));
  const deleteBranchEnd = source.indexOf('} catch (error) {', deleteBranchStart);
  const cloudDeleteBranch = source.slice(deleteBranchStart, deleteBranchEnd);
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

test('canonical quoted human messages map source metadata for transcript rendering', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
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


test('cloud fallback runtime failures render as normal failed agent turns with concise copy', () => {
  const identityById = new Map([
    ['human:me', { id: 'human:me', kind: 'human' as const, displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
    ['agent:me', { id: 'agent:me', kind: 'agent' as const, displayName: 'Kordi', ownerIdentityId: 'human:me', source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: null, agentId: 'local-agent', avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 }],
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

test('cloud group requesting placeholder times out to unavailable notice instead of misleading auth copy', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.match(source, /CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS/);
  const timeoutIndex = source.indexOf('window.setTimeout(() => {');
  assert.ok(timeoutIndex >= 0, 'expected requesting placeholder timeout');
  const timeoutBlock = source.slice(timeoutIndex, timeoutIndex + 2500);
  assert.match(timeoutBlock, /cloudGroupAgentUnavailableFallbackRequest\(\{/);
  assert.match(source, /CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE/);
  assert.match(source, /sourceEventId: `cloud-group-agent-unavailable-timeout:/);
  assert.match(source, /status:\s*'failed'/);
  assert.match(source, /sourceTransport:\s*'cloud-group-agent-offline'/);
});

test('cloud group terminal hosted-agent responses clear timeout placeholders and keep agent attribution', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.match(source, /removeCloudGroupTimeoutPlaceholderForTerminalResponse/);
  assert.match(source, /cloud-group-agent-unavailable-timeout:/);
  assert.match(source, /sender: agentDisplayName/);
  assert.doesNotMatch(source, /sender:\s*'My Kordi'/);
});

test('cloud group hosted-agent metadata targets the owner runtime even when text is not My Kordi', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.match(source, /targetCloudAgentOwnerAccountId === account\.accountId/);
  assert.match(source, /targetCloudAgentId\.startsWith\('cloud_agent_'\)/);
  assert.match(source, /groupMessageTargetsOwnedHostedCloudAgent[\s\S]*cloudMessageMentionsLocalAgent/);
  assert.match(source, /targetCloudAgentId: envelope\.message!\.targetCloudAgentId/);
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
