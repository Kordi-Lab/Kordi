import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import * as cloudBridgeStateModule from '../src/features/cloud/useCloudBridgeState';
import {
  buildCloudBridgeConversation,
  buildCloudDesktopBridgeState,
  cloudBridgeConversationId,
  cloudDirectPersonSessionId,
  cloudContactsToCanonicalIdentityRequests,
  cloudGroupParticipantContacts,
  cloudMessageToBridgeMessage,
  cloudPeerAccountIdFromConversationId,
  isCloudBridgeConversationId,
} from '../src/features/cloud/cloudBridgeState';
import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import { encodeCloudAgentCancel, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudGroupForkPayloadFromSessionMetadata, cloudGroupParticipantsWithProfiles, encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { sharedCloudAgentMentionCandidatesForConversation } from '../src/features/chat/messageActions/mentions';
import {
  cloudAgentMentionCandidates,
  cloudBootstrapPeerIds,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentProcessingMessageForRequest,
  cloudGroupAgentProcessingSlotForResponse,
  optimisticCloudAgentCancelMessage,
  cloudSelfAgentDerivedSyncedStatusBySessionId,
  planCloudSelfAgentSync,
  planCloudSelfAgentCanonicalSync,
  seedCloudSelfAgentForwardSyncLedger,
  cloudMessagesByPeerEqual,
  mergeCloudMessagesByPeerSnapshot,
  markCloudMessagesReadLocally,
  loadCloudMessagesByPeerUntilStable,
  cloudInitialMessagesSettledForPeerKey,
  cloudSessionForksByIdEqual,
  shouldRunLocalCloudAgentForCloudMessage,
  cloudAgentResponseExistsForRequest,
  cloudGroupAgentResponseExistsForRequest,
  cloudAgentRunStatusAlreadyOwnsRequest,
  cloudFallbackRunClaimsForMessages,
  cachedCloudMessagesByPeerHasMessages,
  loadCachedCloudMessagesByPeer,
  saveCachedCloudMessagesByPeer,
} from '../src/features/cloud/useCloudBridgeState';
import { cloudAgentRuntimeRouteForSession } from '../src/features/cloud/cloudAgentRuntime';
import { messageActionSourceFromMessage } from '../src/features/chat/messageActionMetadata';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-05-11T00:00:00Z',
});

test('direct Cloud forwarded envelopes survive bridge transcript mapping', () => {
  const source = {
    sourceSessionId: 'session:source',
    sourceMessageId: 'msg:source',
    senderLabel: 'Peer Person',
    textPreview: 'Original message',
    attachmentCount: 0,
    timeLabel: '10:42',
  };
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'Original message',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source,
    },
  });
  const bridgeMessage = cloudMessageToBridgeMessage(account, {
    messageId: 'msg_cloud_forward',
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body,
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapBridgeConversationToViewModel({
    id: cloudBridgeConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
  }, undefined, 'Kordi');

  assert.equal(bridgeMessage.messageAction?.kind, 'forward');
  assert.equal(view.messages[0]?.messageAction?.kind, 'forward');
  assert.equal(view.messages[0]?.messageAction?.source.senderLabel, 'Peer Person');
});

test('direct Cloud hosted shared-agent requests and responses keep the shared agent display name', () => {
  const requestBody = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@KordiProjectDriver hii',
    targetCloudAgentId: 'cloud_agent_project',
    targetCloudAgentName: 'Kordi Project Driver',
    targetCloudAgentOwnerAccountId: 'acct_peer',
    targetCloudAgentOwnerName: 'Peer Person',
  });
  const request: CloudMessage = {
    messageId: 'msg_direct_project_request',
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body: requestBody,
    createdAt: '2026-06-23T01:41:34.463Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  };
  const response: CloudMessage = {
    messageId: 'msg_direct_project_response',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'Hi! How can I help?',
      deliveryState: 'complete',
    }),
    createdAt: '2026-06-23T01:41:47.467Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  };

  const conversation = buildCloudBridgeConversation({
    account,
    contact: peer,
    messages: [request, response],
    runtime: 'person',
  });
  const responseMessage = conversation.messages.find((message) => message.id === response.messageId);

  assert.equal(responseMessage?.sender, 'Kordi Project Driver');
  assert.equal(responseMessage?.requestId, request.messageId);
  assert.equal(conversation.outreach, null);

  const pendingConversation = buildCloudBridgeConversation({
    account,
    contact: peer,
    messages: [request],
    runtime: 'person',
  });

  const pendingProcessing = pendingConversation.messages.find((message) => message.id === `cloud-agent-processing:${request.messageId}`);
  const pendingView = mapBridgeConversationToViewModel(pendingConversation, undefined, 'Kordi');
  const pendingViewProcessing = pendingView.messages.find((message) => message.turn?.status === 'processing');

  assert.equal(pendingConversation.outreach?.targetDisplayName, 'Kordi Project Driver');
  assert.equal(pendingProcessing?.sender, 'Kordi Project Driver');
  assert.equal(pendingViewProcessing?.sender, 'Kordi Project Driver');
});

test('direct Cloud forwarded headers rewrite legacy Me labels to the remote human profile name', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'h every',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:legacy',
        sourceMessageId: 'msg:legacy',
        senderLabel: 'Me',
        textPreview: 'legacy source',
        attachmentCount: 0,
        timeLabel: '13:46',
      },
    },
  });
  const bridgeMessage = cloudMessageToBridgeMessage(account, {
    messageId: 'msg_legacy_me_forward',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body,
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapBridgeConversationToViewModel({
    id: cloudBridgeConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    canonicalSessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
    identity: {
      bridgeHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Peer Person',
      remoteAgentId: 'cloud-agent:acct_peer',
      remoteAgentName: "Peer Person's Kordi",
    },
  }, undefined, 'Kordi');

  assert.equal(view.messages[0]?.messageAction?.source.senderLabel, 'Peer Person');
  assert.equal(view.messages[0]?.sourceMessage?.senderLabel, 'Peer Person');
});

test('direct Cloud forwarded headers rewrite legacy My Kordi labels to the remote agent profile name', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'agent source',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:legacy-agent',
        sourceMessageId: 'msg:legacy-agent',
        senderLabel: 'My Kordi',
        textPreview: 'legacy agent source',
        attachmentCount: 0,
        timeLabel: '13:46',
      },
    },
  });
  const bridgeMessage = cloudMessageToBridgeMessage(account, {
    messageId: 'msg_legacy_agent_forward',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body,
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapBridgeConversationToViewModel({
    id: cloudBridgeConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    canonicalSessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
    identity: {
      bridgeHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Peer Person',
      remoteAgentId: 'cloud-agent:acct_peer',
      remoteAgentName: "Peer Person's Kordi",
    },
  }, undefined, 'Kordi');

  assert.equal(view.messages[0]?.messageAction?.source.senderLabel, "Peer Person's Kordi");
  assert.equal(view.messages[0]?.sourceMessage?.senderLabel, "Peer Person's Kordi");
});

test('direct Cloud forwards use real local display name as source sender label', () => {
  const bridgeMessage = cloudMessageToBridgeMessage(account, {
    messageId: 'msg_plain_source',
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body: 'source text',
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapBridgeConversationToViewModel({
    id: cloudBridgeConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    canonicalSessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
    identity: {
      bridgeHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Peer Person',
      remoteAgentId: 'cloud-agent:acct_peer',
      remoteAgentName: "Peer Person's Kordi",
    },
  }, undefined, 'Kordi');
  const source = messageActionSourceFromMessage(view.messages[0]!, view.canonicalSessionId!);

  assert.equal(view.messages[0]?.sender, 'Me');
  assert.equal(source?.senderLabel, 'Me Cloud');
});

test('direct Cloud forwards use real remote human name as source sender label', () => {
  const bridgeMessage = cloudMessageToBridgeMessage(account, {
    messageId: 'msg_remote_source',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body: 'remote text',
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapBridgeConversationToViewModel({
    id: cloudBridgeConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    canonicalSessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
    identity: {
      bridgeHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Peer Person',
      remoteAgentId: 'cloud-agent:acct_peer',
      remoteAgentName: "Peer Person's Kordi",
    },
  }, undefined, 'Kordi');
  const source = messageActionSourceFromMessage(view.messages[0]!, view.canonicalSessionId!);

  assert.equal(view.messages[0]?.sender, 'Peer Person');
  assert.equal(source?.senderLabel, 'Peer Person');
});

test('direct Cloud forwards use real local agent owner name as source sender label', () => {
  const view = mapBridgeConversationToViewModel({
    id: cloudBridgeConversationId(account.accountId, 'kordi-desktop', 'session:self'),
    peerNodeId: account.accountId,
    peerRuntime: 'kordi-desktop',
    peerDisplayName: 'My Kordi',
    peerOwnerName: account.displayName,
    canonicalSessionId: 'session:self',
    messages: [{
      id: 'msg_agent_source',
      direction: 'outbound_response',
      sender: 'My Kordi',
      text: 'Agent answer',
      timeLabel: '10:43',
      timestampMs: Date.parse('2026-06-08T04:53:48.645Z'),
      deliveryState: 'complete',
      attachments: [],
      localTurn: null,
    }],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:48.645Z'),
    identity: {
      bridgeHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: account.accountId,
      remoteHumanName: account.displayName,
      remoteAgentId: 'cloud-local-agent',
      remoteAgentName: 'My Kordi',
    },
  }, undefined, 'Kordi');
  const source = messageActionSourceFromMessage(view.messages[0]!, view.canonicalSessionId!);

  assert.equal(view.messages[0]?.sender, 'My Kordi');
  assert.equal(source?.senderLabel, "Me Cloud's Kordi");
});

test('cloud agent runtime routes fall back to current composer route for unconfigured cloud sessions', () => {
  const route = cloudAgentRuntimeRouteForSession({}, 'cloud-agent:acct_me:session:group:one', {
    model: 'anthropic/claude-opus-4-7',
    authProvider: 'anthropic',
    authChoice: 'o_auth',
    thinking: 'medium',
  });

  assert.deepEqual(route, {
    model: 'anthropic/claude-opus-4-7',
    authProvider: 'anthropic',
    authChoice: 'o_auth',
    thinking: 'medium',
  });
});

test('cloud bridge state does not replay stale localStorage messages before server sync settles', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');

  assert.match(source, /if \(!initialMessagesSettled\) return \{\};[\s\S]*removeCloudSessionMessages\(account\.accountId, next, sessionId\)/);
  assert.match(source, /loadCloudSessionVisibility\(account\?\.accountId\)/);
  assert.match(source, /if \(!account \|\| messagesCacheAccountRef\.current !== account\.accountId\) return;[\s\S]*saveCloudSessionVisibility/);
  assert.match(source, /messagesByPeer: visibleMessagesByPeer,/);
  assert.match(source, /if \(!account \|\| !canonicalSessionState\?\.profile\.humanIdentityId \|\| !setCanonicalSessionState \|\| !initialMessagesSettled\) return;[\s\S]*cloudGroupControlMessagesForAccount/);
});

test('cloud unread badge reconciliation waits for authoritative startup message sync', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  const unreadEffectStart = source.indexOf('const unreadBySessionId = cloudGroupUnreadCountsBySessionId({');
  assert.notEqual(unreadEffectStart, -1, 'expected Cloud group unread reconciliation effect');
  const effectGuardStart = source.lastIndexOf('if (', unreadEffectStart);
  assert.notEqual(effectGuardStart, -1, 'expected Cloud group unread effect guard');
  const effectGuard = source.slice(effectGuardStart, unreadEffectStart);

  assert.match(
    effectGuard,
    /!initialMessagesSettled/,
    'cached Cloud messages must not persist unread badges until the first authoritative server sync settles',
  );
});

test('cloud startup performs full message refresh before accepting diff-synced cache as settled', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');

  assert.match(source, /syncCloudBridgeDiff\(\{\s*settleInitialMessages:\s*false\s*\}\)[\s\S]*refreshCloudBridgeMessages\(\)/);
  assert.match(source, /if \(settleInitialMessages\) setInitialMessagesSettledPeerKey\(bootstrapPeerKey\)/);
});

test('Cloud focus refresh is throttled across focus, visibility, and pageshow bursts', () => {
  const shouldRefreshCloudForVisibility = (cloudBridgeStateModule as Record<string, unknown>).shouldRefreshCloudForVisibility;
  const shouldRunCloudFocusRefresh = (cloudBridgeStateModule as Record<string, unknown>).shouldRunCloudFocusRefresh;
  assert.equal(typeof shouldRefreshCloudForVisibility, 'function', 'expected a Cloud visibility-refresh helper');
  assert.equal(typeof shouldRunCloudFocusRefresh, 'function', 'expected a Cloud focus-refresh throttle helper');

  assert.equal((shouldRefreshCloudForVisibility as (state: DocumentVisibilityState) => boolean)('visible'), true);
  assert.equal((shouldRefreshCloudForVisibility as (state: DocumentVisibilityState) => boolean)('hidden'), false);
  assert.equal((shouldRunCloudFocusRefresh as (now: number, last: number) => boolean)(20_000, 0), true);
  assert.equal((shouldRunCloudFocusRefresh as (now: number, last: number) => boolean)(20_100, 20_000), false);
  assert.equal((shouldRunCloudFocusRefresh as (now: number, last: number) => boolean)(25_000, 20_000), true);
});

test('Cloud reactivation keeps hot cache interactive before running background refresh', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  assert.match(source, /CLOUD_FOCUS_REFRESH_DELAY_MS/, 'expected a short Cloud reactivation refresh delay constant');
  assert.match(source, /cloudFocusRefreshTimerRef/, 'expected Cloud focus refreshes to coalesce into one delayed timer');
  assert.match(source, /window\.setTimeout\(runRefresh, CLOUD_FOCUS_REFRESH_DELAY_MS\)/, 'focus refresh should be scheduled after the hot-cache frame');
  assert.match(source, /window\.clearTimeout\(cloudFocusRefreshTimerRef\.current\)/, 'bursts should cancel the previous delayed refresh timer');
});

test('Cloud full message refreshes are single-flight and account-safe', () => {
  const createSingleFlight = (cloudBridgeStateModule as Record<string, unknown>).createAccountScopedSingleFlight;
  assert.equal(typeof createSingleFlight, 'function', 'expected an account-scoped single-flight coordinator');

  const run = (createSingleFlight as () => (
    accountId: string,
    task: () => Promise<void>,
  ) => Promise<void>)();
  let releaseFirstAccount!: () => void;
  const firstAccountBlocked = new Promise<void>((resolve) => {
    releaseFirstAccount = resolve;
  });
  let firstAccountStarts = 0;
  let secondAccountStarts = 0;

  const first = run('acct_first', async () => {
    firstAccountStarts += 1;
    await firstAccountBlocked;
  });
  const duplicate = run('acct_first', async () => {
    firstAccountStarts += 1;
  });
  const second = run('acct_second', async () => {
    secondAccountStarts += 1;
  });

  assert.equal(duplicate, first, 'same-account refreshes should share one promise');
  assert.equal(firstAccountStarts, 1);
  assert.equal(secondAccountStarts, 1, 'a new account must not wait behind the old account refresh');

  releaseFirstAccount();
  return Promise.all([first, duplicate, second]).then(() => undefined);
});

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
}

test('cloud session fork map equality compares structural fork lineage to prevent refresh loops', () => {
  const left = {
    child: {
      forkSessionId: 'child',
      parentSessionId: 'parent',
      parentMessageId: 'msg:parent',
      createdByAccountId: 'acct_me',
      createdAt: '2026-05-17T09:00:00Z',
    },
  };
  const right = {
    child: { ...left.child },
  };
  const changed = {
    child: { ...left.child, parentMessageId: 'msg:other' },
  };

  assert.equal(cloudSessionForksByIdEqual(left, right), true);
  assert.equal(cloudSessionForksByIdEqual(left, changed), false);
});

test('cloud bridge state ignores poisoned localhost bridge state instead of merging it', () => {
  const cloudState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: {},
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
    localAgentTurnsByRequestId: {},
    localAgentRuntimeRoute: null,
    cloudSessionTitlesById: {},
    hiddenCloudSessionIds: new Set(),
    suppressUnscopedSelfAgentConversation: false,
  });

  assert.deepEqual(cloudState.hosts.map((host) => host.id), ['cloud']);
  assert.equal(cloudState.conversations.every((conversation) => conversation.hostId === 'cloud'), true);
});

test('cloud message local cache round-trips all peer chat messages', () => {
  const storage = memoryStorage();
  saveCachedCloudMessagesByPeer('acct_me', {
    acct_peer: [message],
    acct_group_peer: [{ ...message, messageId: 'msg_group_1', fromAccountId: 'acct_group_peer' }],
  }, storage);

  assert.equal(cachedCloudMessagesByPeerHasMessages('acct_me', storage), true);
  assert.deepEqual(loadCachedCloudMessagesByPeer('acct_me', storage), {
    acct_peer: [message],
    acct_group_peer: [{ ...message, messageId: 'msg_group_1', fromAccountId: 'acct_group_peer' }],
  });
});

test('cloud message local cache ignores malformed cached records', () => {
  const storage = memoryStorage();
  storage.setItem('kordi.cloud.messagesByPeer.v1:acct_me', JSON.stringify({
    acct_peer: [{ messageId: '', fromAccountId: 'acct_peer' }, message],
  }));

  assert.deepEqual(loadCachedCloudMessagesByPeer('acct_me', storage), { acct_peer: [message] });
});

test('cloud message cache normalizes self-addressed rows as outgoing and preserves session ids', () => {
  const storage = memoryStorage();
  storage.setItem('kordi.cloud.messagesByPeer.v1:acct_self', JSON.stringify({
    acct_self: [{
      messageId: 'msg_self_1',
      fromAccountId: 'acct_self',
      toAccountId: 'acct_self',
      body: 'cached self row',
      createdAt: '2026-07-07T18:00:00Z',
      deliveredAt: '2026-07-07T18:00:00Z',
      readAt: null,
      direction: 'incoming',
      sessionId: 'session:self-agent:test',
    }],
  }));

  const loaded = loadCachedCloudMessagesByPeer('acct_self', storage);
  assert.equal(loaded.acct_self?.[0]?.direction, 'outgoing');
  assert.equal(loaded.acct_self?.[0]?.sessionId, 'session:self-agent:test');
});

test('cloud group read marking patches stale local unread cache rows by session id', () => {
  const groupBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:abc',
    groupSpaceId: 'session:group:abc',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' },
    participants: [],
    message: {
      id: 'msg:group-agent-final',
      senderAccountId: 'acct_peer',
      text: 'Hi 👋 How can I help?',
      createdAtMs: Date.parse('2026-05-11T10:00:00Z'),
      senderKind: 'agent',
      senderDisplayName: 'Kordi Project Driver',
    },
  });
  const staleGroupMessage: CloudMessage = {
    ...message,
    messageId: 'msg_group_final',
    body: groupBody,
    sessionId: 'session:group:abc',
    readAt: null,
  };
  const directUnreadMessage: CloudMessage = {
    ...message,
    messageId: 'msg_direct_unread',
    sessionId: 'session:direct-person:acct_me:acct_peer',
    readAt: null,
  };

  const patched = markCloudMessagesReadLocally(
    { acct_peer: [staleGroupMessage, directUnreadMessage] },
    'acct_me',
    { sessionIds: ['session:group:abc'] },
    '2026-05-11T10:01:00Z',
  );

  assert.equal(patched.acct_peer?.[0]?.readAt, '2026-05-11T10:01:00Z');
  assert.equal(patched.acct_peer?.[1]?.readAt, null);
});

test('cloud message refresh snapshots preserve locally merged newer messages', () => {
  const greeting: CloudMessage = {
    ...message,
    messageId: 'msg_hello',
    body: 'hello',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const justSent: CloudMessage = {
    ...message,
    messageId: 'msg_sent',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    direction: 'outgoing',
    body: 'hiho w are you',
    createdAt: '2026-05-11T10:00:05Z',
    deliveredAt: '2026-05-11T10:00:05Z',
    sessionId: 'session:direct-person:acct_me:acct_peer',
  };

  const merged = mergeCloudMessagesByPeerSnapshot(
    { acct_peer: [greeting, justSent] },
    { acct_peer: [greeting] },
  );

  assert.deepEqual(merged.acct_peer?.map((item) => item.messageId), ['msg_hello', 'msg_sent']);
});

test('cloud message peer equality detects attachment cache updates', () => {
  const baseMessage: CloudMessage = {
    ...message,
    attachments: [{
      attachmentId: 'att_1',
      name: 'Screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 68 * 1024,
      localPath: null,
    }],
  };

  assert.equal(cloudMessagesByPeerEqual({ acct_peer: [baseMessage] }, {
    acct_peer: [{
      ...baseMessage,
      attachments: [{
        ...baseMessage.attachments![0]!,
        localPath: '/tmp/kordi-cache/Screenshot.png',
      }],
    }],
  }), false);
});

test('cloud bridge messages preserve resolved attachment local paths for inline previews', () => {
  const mapped = cloudMessageToBridgeMessage(account, {
    ...message,
    attachments: [{
      attachmentId: 'att_1',
      name: 'Screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 68 * 1024,
      localPath: '/tmp/kordi-cache/Screenshot.png',
    }],
  }, peer);

  assert.equal(mapped.attachments?.[0]?.attachmentId, 'att_1');
  assert.equal(mapped.attachments?.[0]?.localPath, '/tmp/kordi-cache/Screenshot.png');
});

test('shared cloud agent mention candidates require owner participant', () => {
  const sharedAgent = {
    agentId: 'cloud_agent_project',
    ownerAccountId: 'acct_owner',
    ownerDisplayName: 'Shuyang',
    accessScope: 'participant_conversations' as const,
    name: 'Project Driver',
    role: 'Planning agent',
    description: null,
    updatedAt: '2026-06-19T00:00:00Z',
  };

  const withOwner = sharedCloudAgentMentionCandidatesForConversation([sharedAgent], {
    canonicalParticipants: [
      { id: 'human:acct_owner', kind: 'human', role: 'person', name: 'Shuyang', humanId: 'acct_owner' },
      { id: 'human:acct_requester', kind: 'human', role: 'self', name: 'Alice', humanId: 'acct_requester' },
    ],
    directness: 'group',
  });

  assert.equal(withOwner[0]?.handle, 'ProjectDriver');
  assert.equal(withOwner[0]?.targetAgentId, 'cloud_agent_project');
  assert.equal(withOwner[0]?.targetOwnerAccountId, 'acct_owner');
  assert.equal(withOwner[0]?.detailLabel, "Shuyang's Agent");

  const withoutOwner = sharedCloudAgentMentionCandidatesForConversation([sharedAgent], {
    canonicalParticipants: [
      { id: 'human:acct_requester', kind: 'human', role: 'self', name: 'Alice', humanId: 'acct_requester' },
    ],
    directness: 'group',
  });
  assert.deepEqual(withoutOwner, []);
});

test('cloud group agent mention candidates include owner self-mentions for hosted Cloud Agents', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: '111' },
    sessions: [],
    identities: [
      { id: 'human:me', kind: 'human', displayName: '111', source: 'bridge', bridgeNodeId: 'acct_me', humanId: 'acct_me', ownerIdentityId: null, sourceHostId: 'cloud', agentId: null, avatarKey: 'me', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [{
      id: 'msg_self_hosted_agent_request',
      sessionId: 'session:group:abc',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@KordiProjectDriver hi',
      content: { mentions: [{ targetKind: 'bridge-agent', bridgeHostId: 'cloud', humanId: 'acct_me', agentId: 'cloud_agent_project', label: 'Kordi Project Driver', ownerName: '111' }] },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentHash: null,
      sourceTransport: 'cloud-group-ui',
      sourceEventId: 'cloud-group:msg_self_hosted_agent_request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: null,
  } satisfies CanonicalSessionState;

  const candidates = cloudAgentMentionCandidates(state, 'acct_me');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.targetAccountId, 'acct_me');
  assert.equal(candidates[0]?.targetCloudAgentId, 'cloud_agent_project');
  assert.equal(candidates[0]?.targetAgentDisplayName, 'Kordi Project Driver');
});

test('direct Cloud hosted shared-agent mentions stay eligible for direct fallback runs', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@KordiProjectDriver hi',
    targetCloudAgentId: 'cloud_agent_project',
    targetCloudAgentName: 'Kordi Project Driver',
    targetCloudAgentOwnerAccountId: 'acct_peer',
    targetCloudAgentOwnerName: 'Peer Person',
  });
  const message: CloudMessage = {
    messageId: 'msg_direct_shared_agent',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body,
    createdAt: new Date().toISOString(),
    direction: 'outgoing',
    readAt: null,
    sessionId: cloudDirectPersonSessionId('acct_me', 'acct_peer'),
    attachments: [],
  };

  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account: { ...account, accountId: 'acct_peer' },
    peerId: 'acct_me',
    message,
    peerMessages: [message],
  }), true);

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.sessionId, cloudDirectPersonSessionId('acct_me', 'acct_peer'));
  assert.equal(claims[0]?.targetCloudAgentId, 'cloud_agent_project');
});

test('direct Cloud contact agent mentions are not treated as Cloud group placeholders', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: 'Me' },
    sessions: [],
    identities: [
      { id: 'human:peer', kind: 'human', displayName: 'Peer Person', source: 'bridge', bridgeNodeId: 'acct_peer', humanId: 'acct_peer', ownerIdentityId: null, sourceHostId: 'cloud', agentId: null, avatarKey: 'peer', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud:acct_peer', kind: 'agent', displayName: "Peer Person's Kordi", source: 'bridge', bridgeNodeId: 'cloud-agent:acct_peer', humanId: 'acct_peer', ownerIdentityId: 'human:peer', sourceHostId: 'cloud', agentId: 'cloud-agent:acct_peer', avatarKey: 'peer-agent', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [{
      id: 'msg_direct_request',
      sessionId: 'session:direct-person:acct_me:acct_peer',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@PeerKordi hi',
      content: { mentions: [{ targetKind: 'bridge-agent', bridgeHostId: 'cloud', humanId: 'acct_peer', label: "Peer's Kordi" }] },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentHash: null,
      sourceTransport: 'cloud-direct',
      sourceEventId: 'cloud-direct:msg_direct_request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: null,
  } satisfies CanonicalSessionState;

  assert.deepEqual(cloudAgentMentionCandidates(state, 'acct_me'), []);
});

test('cloud group agent mention candidates ignore inherited fork snapshot rows', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: 'Me' },
    sessions: [],
    identities: [
      { id: 'human:peer', kind: 'human', displayName: 'Peer Person', source: 'bridge', bridgeNodeId: 'acct_peer', humanId: 'acct_peer', ownerIdentityId: null, sourceHostId: 'cloud', agentId: null, avatarKey: 'peer', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud:acct_peer', kind: 'agent', displayName: "Peer Person's Kordi", source: 'bridge', bridgeNodeId: 'cloud-agent:acct_peer', humanId: 'acct_peer', ownerIdentityId: 'human:peer', sourceHostId: 'cloud', agentId: 'cloud-agent:acct_peer', avatarKey: 'peer-agent', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [{
      id: 'msg_snapshot_request',
      sessionId: 'session:fork:abc',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@PeerPersonKordi hello',
      content: { mentions: [{ targetKind: 'bridge-agent', bridgeHostId: 'cloud', humanId: 'acct_peer', label: "PeerPerson's Kordi" }] },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentHash: null,
      sourceTransport: 'canonical-fork-snapshot',
      sourceEventId: 'fork-snapshot:msg_snapshot_request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: null,
  } satisfies CanonicalSessionState;

  assert.deepEqual(cloudAgentMentionCandidates(state, 'acct_me'), []);
});

test('cloud group fork payload is recovered from canonical fork metadata', () => {
  assert.deepEqual(cloudGroupForkPayloadFromSessionMetadata({
    fork: {
      forkedFromSessionId: 'session:group:source',
      forkedFromMessageId: 'msg:source',
      createdAtMs: 1234,
    },
  }, 'session:fork:abc'), {
    forkSessionId: 'session:fork:abc',
    parentSessionId: 'session:group:source',
    parentMessageId: 'msg:source',
    createdAtMs: 1234,
  });
});

test('cloud bridge conversation ids use normal bridge ids with cloud host sentinel', () => {
  assert.equal(cloudBridgeConversationId('acct_peer'), 'bridge:cloud:acct_peer:person');
  assert.equal(cloudBridgeConversationId('acct_peer', 'kordi-desktop'), 'bridge:cloud:acct_peer');
  assert.equal(cloudDirectPersonSessionId('acct_me', 'acct_peer'), 'session:direct-person:acct_me:acct_peer');
  assert.equal(cloudDirectPersonSessionId('acct_peer', 'acct_me'), 'session:direct-person:acct_me:acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer:person'), 'acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer'), 'acct_peer');
  assert.equal(isCloudBridgeConversationId('bridge:local:node:person'), false);
});

test('cloud self-agent derived sync status marks sessions with Cloud self rows as synced', () => {
  const statuses = cloudSelfAgentDerivedSyncedStatusBySessionId('acct_me', {
    acct_me: [{
      messageId: 'msg_synced',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      body: 'hello',
      createdAt: '2026-05-16T08:41:34.336Z',
      deliveredAt: null,
      readAt: null,
      sessionId: 'session:fork:hello',
    }],
  }, 1000);

  assert.equal(statuses['session:fork:hello']?.state, 'synced');
  assert.equal(statuses['session:fork:hello']?.updatedAtMs, 1000);
});

test('cloud self-agent bridge state preserves one Cloud conversation per local session id', () => {
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_s1_u1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'session one prompt',
      sessionId: 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e',
      createdAt: '2026-05-11T10:00:00Z',
    },
    {
      ...message,
      messageId: 'msg_s2_u1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'session two prompt',
      sessionId: 'fed8e7f6-fe4a-4598-b83e-3d21a20f978a',
      createdAt: '2026-05-11T10:01:00Z',
    },
    {
      ...message,
      messageId: 'msg_legacy_collapsed',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'old collapsed prompt',
      sessionId: null,
      createdAt: '2026-05-11T10:02:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });

  assert.deepEqual(
    state.conversations.map((conversation) => conversation.canonicalSessionId).sort(),
    ['f51f7d19-8c8f-4228-9cdd-074ae9b2146e', 'fed8e7f6-fe4a-4598-b83e-3d21a20f978a'].sort(),
  );
  const first = state.conversations.find((conversation) => conversation.canonicalSessionId === 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e');
  assert.ok(first);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].text, 'session one prompt');
});

test('cloud self-agent bridge state restores session titles instead of naming every thread My Kordi', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'what is open claw',
      sessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
    cloudSessionTitlesById: { [sessionId]: 'OpenClaw notes' },
  });

  assert.equal(state.conversations[0]?.title, 'OpenClaw notes');
  assert.equal(state.conversations[0]?.peerDisplayName, 'OpenClaw notes');
});

test('cloud self-agent bridge state falls back to the first prompt as restored title', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'waht is open claw',
      sessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });

  assert.equal(state.conversations[0]?.title, 'waht is open claw');
  assert.equal(state.conversations[0]?.peerDisplayName, 'waht is open claw');
});

test('cloud self-agent bridge state hides sessions already restored into canonical local chat', () => {
  const cloudSessionId = 'restored-self-session';
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: {
      [account.accountId]: [{
        messageId: 'msg_self_request',
        fromAccountId: account.accountId,
        toAccountId: account.accountId,
        body: 'restored question',
        createdAt: '2026-05-16T08:00:00.000Z',
        deliveredAt: null,
        readAt: null,
        sessionId: cloudSessionId,
      }],
    },
    hiddenCloudSessionIds: new Set([cloudSessionId]),
  });

  assert.deepEqual(state.conversations.map((conversation) => conversation.id), []);
});

test('cloud self-agent bridge state suppresses local canonical fork sessions', () => {
  const forkSessionId = 'session:fork:abc123';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_fork_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'historical fork prompt',
      sessionId: forkSessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const visibleState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });
  assert.equal(visibleState.conversations.some((conversation) => conversation.canonicalSessionId === forkSessionId), true);

  const suppressedState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
    hiddenCloudSessionIds: new Set([forkSessionId]),
  });
  assert.equal(suppressedState.conversations.some((conversation) => conversation.canonicalSessionId === forkSessionId), false);
});

test('cloud self-agent plain messages show local processing and match session-scoped replies', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const request = {
    ...message,
    messageId: 'msg_plain_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    direction: 'outgoing',
    body: 'are you here',
    sessionId,
    createdAt: new Date().toISOString(),
  } as CloudMessage;
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [request] },
    activeConversationId: cloudBridgeConversationId('acct_me', 'kordi-desktop', sessionId),
  });

  assert.equal(pendingState.conversations[0]?.awaitingReply, true);
  assert.equal(pendingState.conversations[0]?.outreach?.bridgeRequestId, 'msg_plain_self_request');

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [request, {
      ...message,
      messageId: 'msg_plain_self_response',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: encodeCloudAgentResponse({ requestId: 'msg_plain_self_request', text: 'Yes, I can see it.' }),
      sessionId,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    }] },
    activeConversationId: cloudBridgeConversationId('acct_me', 'kordi-desktop', sessionId),
  });

  assert.equal(answeredState.conversations[0]?.awaitingReply, false);
  assert.equal(answeredState.conversations[0]?.outreach, null);
  assert.equal(answeredState.conversations[0]?.messages.at(-1)?.text, 'Yes, I can see it.');
});

test('planCloudSelfAgentSync backfills terminal local self-agent turns without runtime internals', () => {
  const state = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'Hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'cloud-agent:acct_me:runtime', kind: 'self-agent', title: 'Runtime', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hi there', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
      { id: 'u2', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'pending', status: 'sending', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'runtime-u1', sessionId: 'cloud-agent:acct_me:runtime', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'internal', status: 'sent', sequenceNum: 1, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'u1', sessionId: 'local-self-session', role: 'user', text: 'hello', parentLocalMessageId: null, createdAtMs: 10 },
    { localMessageId: 'a1', sessionId: 'local-self-session', role: 'agent', text: 'Hi there', parentLocalMessageId: 'u1', createdAtMs: 20 },
  ]);

  assert.deepEqual(planCloudSelfAgentSync(state, { u1: { cloudMessageId: 'msg_remote', syncedAtMs: 123 } }), [
    { localMessageId: 'a1', sessionId: 'local-self-session', role: 'agent', text: 'Hi there', parentLocalMessageId: 'u1', createdAtMs: 20 },
  ]);

  assert.deepEqual(planCloudSelfAgentSync(state, {}, { allowLocalBackfill: false }), []);
});

test('cloud self-agent canonical sync restores fork lineage metadata', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_child_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'child prompt',
    createdAt: '2026-05-16T08:41:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:fork:child',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [userMessage],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'parent-session',
        parentMessageId: 'msg:cloud:self:parent-agent',
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:00Z',
      },
    },
  });

  assert.deepEqual(plan.sessionRequests[0]?.metadata, {
    cloudSelfAgentSession: true,
    fork: {
      forkedFromSessionId: 'parent-session',
      forkedFromMessageId: 'msg:cloud:self:parent-agent',
    },
  });
});

test('cloud self-agent canonical sync marks restored fork prefix as snapshots for the transcript divider', () => {
  const parentUser: CloudMessage = {
    messageId: 'msg_parent_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'original prompt',
    createdAt: '2026-05-16T08:40:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:parent',
  };
  const parentAgent: CloudMessage = {
    messageId: 'msg_parent_answer',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: parentUser.messageId, text: 'original answer' }),
    createdAt: '2026-05-16T08:40:05.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:parent',
  };
  const forkCopiedUser: CloudMessage = {
    ...parentUser,
    messageId: 'msg_fork_copied_request',
    sessionId: 'session:fork:child',
  };
  const forkCopiedAgent: CloudMessage = {
    ...parentAgent,
    messageId: 'msg_fork_copied_answer',
    body: encodeCloudAgentResponse({ requestId: forkCopiedUser.messageId, text: 'original answer' }),
    sessionId: 'session:fork:child',
  };
  const forkNewUser: CloudMessage = {
    messageId: 'msg_fork_new_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'continued prompt',
    createdAt: '2026-05-16T08:41:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:fork:child',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [forkNewUser, forkCopiedAgent, parentAgent, forkCopiedUser, parentUser],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'session:parent',
        parentMessageId: 'msg:cloud:self:msg_parent_answer',
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:06.000Z',
      },
    },
  });

  assert.deepEqual(plan.messageRequests
    .filter((request) => request.sessionId === 'session:fork:child')
    .map((request) => ({ text: request.contentText, sourceTransport: request.sourceTransport })), [
    { text: 'original prompt', sourceTransport: 'canonical-fork-snapshot' },
    { text: 'original answer', sourceTransport: 'canonical-fork-snapshot' },
    { text: 'continued prompt', sourceTransport: 'cloud-self-agent' },
  ]);
});

test('cloud self-agent canonical sync patches existing restored fork prefix messages into snapshots', () => {
  const parentUser: CloudMessage = {
    messageId: 'msg_parent_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'original prompt',
    createdAt: '2026-05-16T08:40:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:parent',
  };
  const forkCopiedUser: CloudMessage = {
    ...parentUser,
    messageId: 'msg_fork_copied_request',
    sessionId: 'session:fork:child',
  };
  const state = {
    sessions: [{ id: 'session:fork:child', kind: 'self-agent', title: 'original prompt', status: 'active', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:cloud-self:acct_me', projectId: null, projectName: null, relationshipIdentityId: null, metadata: { cloudSelfAgentSession: true }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 }],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [{ id: 'msg:cloud:self:msg_fork_copied_request', sessionId: 'session:fork:child', sequenceNum: 1, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: 'original prompt', content: null, parentMessageId: null, status: 'sent', createdAtMs: Date.parse(parentUser.createdAt), updatedAtMs: Date.parse(parentUser.createdAt), sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_fork_copied_request' }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [parentUser, forkCopiedUser],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'session:parent',
        parentMessageId: null,
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:06.000Z',
      },
    },
  });

  assert.deepEqual(plan.messageRequests
    .filter((request) => request.sessionId === 'session:fork:child')
    .map((request) => ({
      id: request.id,
      sourceTransport: request.sourceTransport,
    })), [
    { id: 'msg:cloud:self:msg_fork_copied_request', sourceTransport: 'canonical-fork-snapshot' },
  ]);
});

test('cloud self-agent canonical sync patches fork lineage onto existing restored sessions', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_child_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'child prompt',
    createdAt: '2026-05-16T08:41:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:fork:child',
  };
  const state = {
    sessions: [{ id: 'session:fork:child', kind: 'self-agent', title: 'child prompt', status: 'active', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:cloud-self:acct_me', projectId: null, projectName: null, relationshipIdentityId: null, metadata: { cloudSelfAgentSession: true }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 }],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [{ id: 'msg:cloud:self:msg_child_request', sessionId: 'session:fork:child', sequenceNum: 1, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: 'child prompt', content: null, parentMessageId: null, status: 'sent', createdAtMs: Date.parse('2026-05-16T08:41:27.120Z'), updatedAtMs: Date.parse('2026-05-16T08:41:27.120Z'), sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_child_request' }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [userMessage],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'parent-session',
        parentMessageId: 'msg:cloud:self:parent-agent',
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:00Z',
      },
    },
  });

  assert.equal(plan.messageRequests.length, 0);
  assert.deepEqual(plan.sessionRequests[0]?.metadata, {
    cloudSelfAgentSession: true,
    fork: {
      forkedFromSessionId: 'parent-session',
      forkedFromMessageId: 'msg:cloud:self:parent-agent',
    },
  });
});

test('cloud self-agent canonical sync materializes restored Cloud private agent sessions', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'sync this question',
    createdAt: '2026-05-16T08:11:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const agentMessage: CloudMessage = {
    messageId: 'msg_self_answer',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: userMessage.messageId, text: 'synced answer' }),
    createdAt: '2026-05-16T08:11:32.820Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [agentMessage, userMessage], state });

  assert.equal(plan.agentIdentityRequest.id, 'agent:cloud-self:acct_me');
  assert.deepEqual(plan.sessionRequests.map((request) => ({ id: request.id, title: request.title, createdByIdentityId: request.createdByIdentityId, primaryIdentityId: request.primaryIdentityId })), [
    { id: 'restored-self-session', title: 'sync this question', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:cloud-self:acct_me' },
  ]);
  assert.deepEqual(plan.messageRequests.map((request) => ({
    id: request.id,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    parentMessageId: request.parentMessageId ?? null,
    sourceEventId: request.sourceEventId,
  })), [
    { id: 'msg:cloud:self:msg_self_request', senderRole: 'user', messageKind: 'text', contentText: 'sync this question', parentMessageId: null, sourceEventId: 'msg_self_request' },
    { id: 'msg:cloud:self:msg_self_answer', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'synced answer', parentMessageId: 'msg:cloud:self:msg_self_request', sourceEventId: 'msg_self_answer' },
  ]);
});

test('cloud self-agent canonical sync materializes scheduled run responses without a matching user request id', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_schedule_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'Schedule a cloud task to search OpenAI news at 19:43.',
    createdAt: '2026-06-09T11:42:14.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'scheduled-session',
  };
  const scheduledResponse: CloudMessage = {
    messageId: 'cloudrunmsg_openai_summary',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: 'scheduled_run_openai_summary', text: 'Here is the latest OpenAI news summary.' }),
    createdAt: '2026-06-09T11:44:19.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'scheduled-session',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [scheduledResponse, userMessage], state });

  assert.deepEqual(plan.messageRequests.map((request) => ({
    id: request.id,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    parentMessageId: request.parentMessageId ?? null,
    sourceEventId: request.sourceEventId,
  })), [
    { id: 'msg:cloud:self:msg_schedule_request', senderRole: 'user', messageKind: 'text', contentText: 'Schedule a cloud task to search OpenAI news at 19:43.', parentMessageId: null, sourceEventId: 'msg_schedule_request' },
    { id: 'msg:cloud:self:cloudrunmsg_openai_summary', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Here is the latest OpenAI news summary.', parentMessageId: null, sourceEventId: 'cloudrunmsg_openai_summary' },
  ]);
});

test('cloud self-agent canonical sync deduplicates repeated Cloud rows within the same restore batch', () => {
  const createdAt = '2026-05-16T08:11:27.120Z';
  const duplicateRequestA: CloudMessage = {
    messageId: 'msg_self_request_a',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'same restored request',
    createdAt,
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const duplicateRequestB: CloudMessage = {
    ...duplicateRequestA,
    messageId: 'msg_self_request_b',
  };
  const duplicateAnswerA: CloudMessage = {
    messageId: 'msg_self_answer_a',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: duplicateRequestA.messageId, text: 'same restored answer' }),
    createdAt: '2026-05-16T08:11:32.820Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const duplicateAnswerB: CloudMessage = {
    ...duplicateAnswerA,
    messageId: 'msg_self_answer_b',
    body: encodeCloudAgentResponse({ requestId: duplicateRequestB.messageId, text: 'same restored answer' }),
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [duplicateAnswerB, duplicateRequestB, duplicateAnswerA, duplicateRequestA],
    state,
  });

  assert.deepEqual(plan.messageRequests.map((request) => ({
    contentText: request.contentText,
    senderRole: request.senderRole,
    parentMessageId: request.parentMessageId ?? null,
  })), [
    { contentText: 'same restored request', senderRole: 'user', parentMessageId: null },
    { contentText: 'same restored answer', senderRole: 'owned-agent', parentMessageId: 'msg:cloud:self:msg_self_request_a' },
  ]);
});

test('cloud self-agent forward sync does not re-upload restored Cloud canonical rows', () => {
  const state = {
    sessions: [
      { id: 'restored-self-session', kind: 'self-agent', title: 'Restored', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'msg:cloud:self:request', sessionId: 'restored-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'restored prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_request' },
      { id: 'msg:cloud:self:answer', sessionId: 'restored-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'restored answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_answer' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), []);
  assert.deepEqual(seedCloudSelfAgentForwardSyncLedger(state, {}, 1000), { ledger: {}, changed: false });
});

test('cloud self-agent canonical sync does not duplicate existing local turns on the sending device', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'already local',
    createdAt: '2026-05-16T08:11:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'local-self-session',
  };
  const state = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'already local', status: 'active', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'local-u1', sessionId: 'local-self-session', senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: 'already local', status: 'sent', sequenceNum: 1, createdAtMs: Date.parse(userMessage.createdAt), updatedAtMs: Date.parse(userMessage.createdAt), sourceTransport: 'desktop-chat' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [userMessage], state });

  assert.equal(plan.messageRequests.length, 0);
});

test('cloud self-agent forward sync seeds existing local history but uploads continued turns', () => {
  const initialState = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'Hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'old-u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'old-a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const seeded = seedCloudSelfAgentForwardSyncLedger(initialState, {}, 1000);
  assert.equal(seeded.changed, true);
  assert.equal(seeded.ledger['old-u1']?.cloudMessageId, null);
  assert.equal(seeded.ledger['old-u1']?.skippedLocalBackfill, true);
  assert.deepEqual(planCloudSelfAgentSync(initialState, seeded.ledger), []);

  const continuedState = {
    ...initialState,
    messages: [
      ...initialState.messages,
      { id: 'new-u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new prompt', status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'new-a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'new answer', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(continuedState, seeded.ledger), [
    { localMessageId: 'new-u1', sessionId: 'local-self-session', role: 'user', text: 'new prompt', parentLocalMessageId: null, createdAtMs: 30 },
    { localMessageId: 'new-a1', sessionId: 'local-self-session', role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40 },
  ]);
});

test('planCloudSelfAgentSync skips inherited fork snapshot rows but keeps new fork turns', () => {
  const forkSessionId = 'session:fork:abc123';
  const state = {
    sessions: [
      { id: forkSessionId, kind: 'self-agent', title: 'Fork', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { fork: { forkedFromSessionId: 'session:group:1' } }, createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'snap-u1', sessionId: forkSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'canonical-fork-snapshot' },
      { id: 'snap-a1', sessionId: forkSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'canonical-fork-snapshot' },
      { id: 'new-u1', sessionId: forkSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new fork prompt', status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30, sourceTransport: 'desktop-chat' },
      { id: 'new-a1', sessionId: forkSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'new answer', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40, sourceTransport: 'desktop-chat' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'new-u1', sessionId: forkSessionId, role: 'user', text: 'new fork prompt', parentLocalMessageId: null, createdAtMs: 30 },
    { localMessageId: 'new-a1', sessionId: forkSessionId, role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40 },
  ]);
});

test('cloud group participants hydrate missing avatars from account profiles', () => {
  const participants = cloudGroupParticipantsWithProfiles([
    { accountId: 'acct_79', displayName: '杨澍', avatarUrl: null, role: 'person' },
  ], [
    { accountId: 'acct_79', displayName: '杨澍', avatarUrl: 'https://lh3.googleusercontent.com/a/google-avatar=s96-c' },
  ]);

  assert.deepEqual(participants, [
    { accountId: 'acct_79', displayName: '杨澍', avatarUrl: 'https://lh3.googleusercontent.com/a/google-avatar=s96-c', role: 'person' },
  ]);
});

test('cloud group participant contacts include non-contact group members for mentions and sending', () => {
  const canonicalSessionState = {
    sessions: [{ id: 'session:group:1', kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 }],
    identities: [
      { id: 'human:acct_me', kind: 'human', displayName: 'Me Cloud', source: 'local', humanId: 'acct_me', avatarKey: 'seed-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:acct_member', kind: 'human', displayName: 'Group Member', source: 'bridge', sourceHostId: 'cloud', bridgeNodeId: 'acct_member', humanId: 'acct_member', avatarKey: 'seed-member', profileImageUrl: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [
      { sessionId: 'session:group:1', identityId: 'human:acct_me', role: 'self', state: 'active', addedAtMs: 1 },
      { sessionId: 'session:group:1', identityId: 'human:acct_member', role: 'person', state: 'active', addedAtMs: 1 },
    ],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const contacts = cloudGroupParticipantContacts({
    account,
    canonicalSessionState,
    existingPeerIds: [],
  });

  assert.deepEqual(contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    bridgeHostId: contact.bridgeHostId,
    bridgePeerNodeId: contact.bridgePeerNodeId,
    bridgeContactStatus: contact.bridgeContactStatus,
    avatarSeed: contact.avatarSeed,
  })), [{
    id: 'cloud:acct_member',
    name: 'Group Member',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_member',
    bridgeContactStatus: 'group-member',
    avatarSeed: 'seed-member',
  }]);
});

test('cloud group members do not become direct contacts or direct chat peers', () => {
  const groupMemberContact = {
    ...cloudContactToContact({
      accountId: 'acct_member',
      displayName: 'Group Member',
      avatarUrl: null,
      nodeId: 'acct_member',
      createdAt: '2026-05-11T00:00:00Z',
    }),
    bridgeContactStatus: 'group-member',
  };
  const body = encodeCloudGroupControl({
    kind: 'group-update',
    groupId: 'session:group:one',
    groupSpaceId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' },
      { accountId: 'acct_member', displayName: 'Group Member', avatarUrl: null, role: 'person' },
    ],
    message: null,
  });
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer, groupMemberContact],
    messagesByPeer: {
      acct_peer: [message],
      acct_member: [{
        messageId: 'msg_group_control',
        fromAccountId: 'acct_member',
        toAccountId: 'acct_me',
        body,
        createdAt: '2026-05-11T10:00:00Z',
        deliveredAt: null,
        readAt: null,
        direction: 'incoming',
      }],
    },
  });

  assert.equal(state.hosts[0]?.visiblePeers.some((visiblePeer) => visiblePeer.humanId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_peer'), true);
});

test('cloud contact identity requests preserve account ids, display names, and uploaded avatar images', () => {
  const requests = cloudContactsToCanonicalIdentityRequests({
    account: {
      ...account,
      avatarUrl: 'data:image/jpeg;base64,me',
    },
    contacts: [cloudContactToContact({
      accountId: 'acct_peer',
      displayName: 'Peer Person',
      avatarUrl: 'data:image/jpeg;base64,peer',
      nodeId: 'node_peer',
      createdAt: '2026-05-11T00:00:00Z',
    })],
    localHumanIdentityId: 'human:local',
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => ({
    id: request.id,
    displayName: request.displayName,
    source: request.source,
    sourceHostId: request.sourceHostId,
    bridgeNodeId: request.bridgeNodeId,
    humanId: request.humanId,
    avatarKey: request.avatarKey,
    profileImageUrl: request.profileImageUrl,
  })), [
    {
      id: 'human:acct_me',
      displayName: 'Me Cloud',
      source: 'local',
      sourceHostId: null,
      bridgeNodeId: null,
      humanId: 'acct_me',
      avatarKey: 'acct_me',
      profileImageUrl: 'data:image/jpeg;base64,me',
    },
    {
      id: 'human:acct_peer',
      displayName: 'Peer Person',
      source: 'bridge',
      sourceHostId: 'cloud',
      bridgeNodeId: 'acct_peer',
      humanId: 'acct_peer',
      avatarKey: 'acct_peer',
      profileImageUrl: 'data:image/jpeg;base64,peer',
    },
  ]);
});

test('cloud bootstrap peers include the signed-in account for private self-agent restore', () => {
  assert.deepEqual(cloudBootstrapPeerIds(account, ['acct_peer'], []), ['acct_me', 'acct_peer']);
});

test('cloud initial message readiness waits for the post-contact peer set', () => {
  assert.equal(cloudInitialMessagesSettledForPeerKey({
    accountReady: true,
    contactsSettled: true,
    currentPeerKey: 'acct_me|acct_peer',
    settledPeerKey: 'acct_me',
  }), false);

  assert.equal(cloudInitialMessagesSettledForPeerKey({
    accountReady: true,
    contactsSettled: true,
    currentPeerKey: 'acct_me|acct_peer',
    settledPeerKey: 'acct_me|acct_peer',
  }), true);
});

test('cloud initial message sync follows group peer discovery until stable', async () => {
  const makeGroupMessage = (peer: string, discoveredPeer: string): CloudMessage => ({
    messageId: `msg_${peer}_${discoveredPeer}`,
    fromAccountId: peer,
    toAccountId: account.accountId,
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: `group_${peer}_${discoveredPeer}`,
      sessionId: `session_${peer}_${discoveredPeer}`,
      createdByAccountId: peer,
      actor: { accountId: peer, displayName: peer, avatarUrl: null },
      participants: [
        { accountId: account.accountId, displayName: 'Me Cloud', avatarUrl: null },
        { accountId: peer, displayName: peer, avatarUrl: null },
        { accountId: discoveredPeer, displayName: discoveredPeer, avatarUrl: null },
      ],
      message: {
        id: `group_msg_${peer}_${discoveredPeer}`,
        senderAccountId: peer,
        text: `hello ${discoveredPeer}`,
        createdAt: '2026-05-13T10:00:00Z',
      },
    }),
    createdAt: '2026-05-13T10:00:00Z',
    deliveredAt: '2026-05-13T10:00:00Z',
    readAt: null,
    direction: 'incoming',
  });

  const messagesByPeer: Record<string, CloudMessage[]> = {
    acct_peer_1: [makeGroupMessage('acct_peer_1', 'acct_peer_2')],
    acct_peer_2: [makeGroupMessage('acct_peer_2', 'acct_peer_3')],
    acct_peer_3: [makeGroupMessage('acct_peer_3', 'acct_peer_4')],
    acct_peer_4: [makeGroupMessage('acct_peer_4', 'acct_peer_5')],
    acct_peer_5: [],
  };

  const result = await loadCloudMessagesByPeerUntilStable({
    accountId: account.accountId,
    initialPeerIds: ['acct_peer_1'],
    existingMessagesByPeer: {},
    listMessages: async (peerId) => messagesByPeer[peerId] ?? [],
    resolveMessageAttachments: async (messages) => messages,
  });

  assert.equal(result.complete, true);
  assert.deepEqual(Object.keys(result.messagesByPeer).sort(), [
    'acct_peer_1',
    'acct_peer_2',
    'acct_peer_3',
    'acct_peer_4',
    'acct_peer_5',
  ]);
});

test('stored self messages restore a private My Kordi cloud agent conversation', () => {
  const selfRequest: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: '@Kordi remember this private note',
    createdAt: '2026-05-11T10:00:00Z',
    deliveredAt: '2026-05-11T10:00:00Z',
    readAt: null,
    direction: 'outgoing',
  };
  const selfResponse: CloudMessage = {
    messageId: 'msg_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_self_request', text: 'I will remember it.' }),
    createdAt: '2026-05-11T10:00:01Z',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: null,
    direction: 'outgoing',
  };

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfRequest, selfResponse] },
    activeConversationId: null,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'bridge:cloud:acct_me');
  assert.equal(state.conversations[0].title, 'My Kordi');
  assert.equal(state.conversations[0].peerRuntime, 'kordi-desktop');
  assert.equal(state.conversations[0].identity.remoteAgentId, 'cloud-local-agent');
  assert.deepEqual(state.conversations[0].messages.map((item) => item.text), [
    '@Kordi remember this private note',
    'I will remember it.',
  ]);
});

test('unscoped self-agent cloud cache is hidden when local canonical self-agent history exists', () => {
  const selfRequest: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: 'hwllo',
    createdAt: '2026-05-11T10:00:00Z',
    deliveredAt: '2026-05-11T10:00:00Z',
    readAt: null,
    direction: 'outgoing',
  };
  const selfResponse: CloudMessage = {
    messageId: 'msg_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_self_request', text: 'Hello! How can I help?' }),
    createdAt: '2026-05-11T10:00:01Z',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: null,
    direction: 'outgoing',
  };

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfRequest, selfResponse] },
    activeConversationId: null,
    suppressUnscopedSelfAgentConversation: true,
  });

  assert.equal(state.conversations.length, 0);
});

test('cloud contacts and messages become normal desktop bridge state', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(state.hosts[0].id, 'cloud');
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'person'), true);
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'kordi-desktop' && candidate.agentId === 'cloud-agent:acct_peer'), true);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'bridge:cloud:acct_peer:person');
  assert.equal(state.conversations[0].messages[0].direction, 'inbound');
  assert.equal(state.conversations[0].messages[0].text, 'hello from cloud');
});

test('active empty cloud conversations are materialized for the existing chat UI', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: {},
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].messages.length, 0);
  assert.equal(state.conversations[0].title, 'Peer Person');
});

test('direct Cloud contact conversations do not render group fanout control payloads', () => {
  const directMessage: CloudMessage = {
    ...message,
    messageId: 'msg_direct_visible',
    body: 'direct hello',
    sessionId: 'session:direct-person:acct_me:acct_peer',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const groupFanout: CloudMessage = {
    ...message,
    messageId: 'msg_group_fanout_hidden',
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: 'session:group:team',
      groupTitle: 'Team',
      createdByAccountId: 'acct_peer',
      actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' },
      participants: [
        { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' },
        { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' },
      ],
      message: {
        id: 'msg_group_inner',
        senderAccountId: 'acct_peer',
        text: '@KordiProjectDriver hi',
        createdAtMs: Date.parse('2026-05-11T10:01:00Z'),
        senderKind: 'human',
      },
    }),
    sessionId: 'session:group:team',
    createdAt: '2026-05-11T10:01:00Z',
  };
  const malformedGroupFanout: CloudMessage = {
    ...message,
    messageId: 'msg_group_fanout_malformed_hidden',
    body: 'kordi-cloud-group:stale-or-truncated-payload',
    sessionId: 'session:group:team',
    createdAt: '2026-05-11T10:02:00Z',
  };

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [directMessage, groupFanout, malformedGroupFanout] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations.length, 1);
  assert.deepEqual(state.conversations[0].messages.map((item) => item.text), ['direct hello']);
  assert.equal(state.conversations[0].messages.some((item) => item.text.startsWith('kordi-cloud-group:')), false);
});

test('active cloud conversations clear unread while inactive conversations keep unread', () => {
  const activeState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const inactiveState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(activeState.conversations[0].unreadCount, 0);
  assert.equal(inactiveState.conversations[0].unreadCount, 1);
});

test('cloud read markers keep previously read inbound messages from becoming unread again', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    readInboundMessageIdsByPeer: { acct_peer: new Set(['msg_1']) },
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud direct unread honors canonical direct-session read cursor when cached readAt is stale', () => {
  const directSessionId = cloudDirectPersonSessionId(account.accountId, 'acct_peer');
  const staleCachedInbound: CloudMessage = {
    ...message,
    messageId: 'cloud_stale_unread_after_cursor',
    sessionId: directSessionId,
    createdAt: '2026-05-11T10:00:00Z',
    readAt: null,
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [staleCachedInbound] },
    readCursorsBySessionId: {
      [directSessionId]: { lastReadMessageId: 'msg:canonical-latest', lastReadCreatedAtMs: Date.parse('2026-05-11T10:00:01Z') },
    },
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud self-agent messages never count as unread badges', () => {
  const selfMessage: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_unread_candidate',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: 'private prompt',
    direction: 'outgoing',
    readAt: null,
    sessionId: 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfMessage] },
    activeConversationId: null,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].canonicalSessionId, 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e');
  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud inbound messages with server read_at do not become unread after relaunch', () => {
  const readInbound: CloudMessage = {
    ...message,
    messageId: 'msg_inbound_read_on_server',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: 'already read',
    direction: 'incoming',
    readAt: '2026-05-11T12:00:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readInbound] },
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud outgoing messages render as delivered once accepted by the cloud server', () => {
  const outgoing: CloudMessage = {
    ...message,
    messageId: 'msg_outgoing',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hi',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [outgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'delivered');
});

test('cloud cloud-agent mention requests and responses use bridge agent directions', () => {
  const request = cloudMessageToBridgeMessage(account, {
    ...message,
    messageId: 'msg_request',
    body: '@MeCloudKordi who are you?',
  });
  const response = cloudMessageToBridgeMessage(account, {
    ...message,
    messageId: 'msg_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: 'msg_request', text: 'I am Kordi.' }),
    direction: 'outgoing',
  });

  assert.equal(request.direction, 'inbound');
  assert.equal(request.requestId, 'msg_request');
  assert.equal(response.direction, 'outbound-response');
  assert.equal(response.sender, null);
  assert.equal(response.requestId, 'msg_request');
  assert.equal(response.text, 'I am Kordi.');
});

test('cloud direct local-agent completed turn replaces processing while Cloud response sync catches up', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_local_agent_request_done_locally',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you check the issue?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn_direct_local_done',
    sessionId: 'cloud-agent:acct_me:acct_peer',
    prompt: 'can you check the issue?',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'I checked it and found the issue.',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: { [request.messageId]: completedTurn },
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.notEqual(agentMessage?.turn?.status, 'processing');
  assert.equal(agentMessage?.turn?.completed, true);
  assert.equal(agentMessage?.turn?.assistantText, 'I checked it and found the issue.');
  assert.equal(view.messages.some((candidate) => candidate.turn?.status === 'processing'), false);
});

test('cloud direct local-agent completed fallback timestamp is stable across renders', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_local_agent_stable_timestamp',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you check the issue?',
    direction: 'incoming',
    createdAt: '1970-01-01T00:00:00.100Z',
  };
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn_direct_local_stable_timestamp',
    sessionId: 'cloud-agent:acct_me:acct_peer',
    prompt: 'can you check the issue?',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'I checked it.',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    const firstState = buildCloudDesktopBridgeState({
      account,
      contacts: [peer],
      messagesByPeer: { acct_peer: [request] },
      activeConversationId: 'bridge:cloud:acct_peer:person',
      localAgentTurnsByRequestId: { [request.messageId]: completedTurn },
    });
    Date.now = () => 2_000;
    const secondState = buildCloudDesktopBridgeState({
      account,
      contacts: [peer],
      messagesByPeer: { acct_peer: [request] },
      activeConversationId: 'bridge:cloud:acct_peer:person',
      localAgentTurnsByRequestId: { [request.messageId]: completedTurn },
    });
    const firstTimestamp = firstState.conversations[0].messages.find((candidate) => candidate.id === `cloud-agent-local-response:${request.messageId}`)?.timestampMs;
    const secondTimestamp = secondState.conversations[0].messages.find((candidate) => candidate.id === `cloud-agent-local-response:${request.messageId}`)?.timestampMs;

    assert.equal(firstTimestamp, 101);
    assert.equal(secondTimestamp, firstTimestamp);
  } finally {
    Date.now = originalNow;
  }
});

test('cloud self-agent responses keep local runtime tool details local to the owner', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloud inspect the repo',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_response_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'I inspected it.' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: {
      [request.messageId]: {
        id: 'turn_1',
        sessionId: 'cloud-agent:acct_me:acct_peer',
        prompt: 'inspect the repo',
        status: 'complete',
        message: 'Complete',
        assistantText: 'I inspected it.',
        thinkingText: 'Looking through files.',
        tools: [{ id: 'tool_1', name: 'read', status: 'completed', arguments: '{}', detail: 'Read package.json', resultText: '', liveOutput: '', isError: false }],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  });

  const bridgeResponse = state.conversations[0].messages.find((candidate) => candidate.id === response.messageId);
  assert.equal(bridgeResponse?.sender, null);
  assert.equal(bridgeResponse?.localTurn?.tools[0]?.name, 'read');

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.equal(agentMessage?.sender, 'My Kordi');
  assert.equal(agentMessage?.turn?.tools[0]?.name, 'read');
});

test('cloud first-person self-agent requests hide accidental duplicate peer responses', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_first_person_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyKordi what is agentic?',
    direction: 'outgoing',
  };
  const validResponse: CloudMessage = {
    ...message,
    messageId: 'msg_valid_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Agentic means acting autonomously.' }),
    direction: 'outgoing',
  };
  const invalidDuplicateResponse: CloudMessage = {
    ...message,
    messageId: 'msg_invalid_peer_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Duplicate response.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, validResponse, invalidDuplicateResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const responses = state.conversations[0].messages.filter((candidate) => candidate.requestId === request.messageId && candidate.id !== request.messageId);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, validResponse.messageId);
});

test('cloud direct hosted-agent requests hide duplicate owner responses for the same request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_hosted_duplicate_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: '@KordiProjectDriver who are you',
      targetCloudAgentId: 'cloud_agent_project',
      targetCloudAgentName: 'Kordi Project Driver',
      targetCloudAgentOwnerAccountId: 'acct_peer',
      targetCloudAgentOwnerName: 'Peer Person',
    }),
    direction: 'outgoing',
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'msg_direct_hosted_duplicate_response_a',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'First response.' }),
    direction: 'incoming',
    createdAt: '2026-06-23T03:28:28.000Z',
  };
  const secondResponse: CloudMessage = {
    ...message,
    messageId: 'msg_direct_hosted_duplicate_response_b',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Second duplicate response.' }),
    direction: 'incoming',
    createdAt: '2026-06-23T03:28:29.000Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, firstResponse, secondResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const responses = state.conversations[0].messages.filter((candidate) => candidate.requestId === request.messageId && candidate.id !== request.messageId);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, firstResponse.messageId);
  assert.equal(responses[0].sender, 'Kordi Project Driver');
});

test('cloud remote-agent responses render with the remote owner agent identity', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_remote_agent_request_label',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi hi',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_remote_agent_response_label',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Hello.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'external-agent');
  assert.equal(agentMessage?.sender, "Peer Person's Kordi");
});

test('active cloud agent bridge placeholders are not materialized as duplicate sessions', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer',
  });

  assert.equal(state.conversations.some((conversation) => conversation.id === 'bridge:cloud:acct_peer:person'), true);
  assert.equal(state.conversations.some((conversation) => conversation.id === 'bridge:cloud:acct_peer'), false);
});

test('cloud parallel agent mentions keep request-specific processing and replies', () => {
  const firstRequest: CloudMessage = {
    ...message,
    messageId: 'msg_first_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi check openclaw',
    direction: 'outgoing',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const secondRequest: CloudMessage = {
    ...message,
    messageId: 'msg_second_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi are you ok?',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'msg_first_agent_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_first_agent_request', text: 'OpenClaw is an agent project.' }),
    direction: 'incoming',
    createdAt: '2026-05-11T10:02:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [firstRequest, secondRequest, firstResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const firstRequestViewId = 'bridge-message:bridge:cloud:acct_peer:person:msg_first_agent_request';
  const secondRequestViewId = 'bridge-message:bridge:cloud:acct_peer:person:msg_second_agent_request';
  const firstReply = view.messages.find((candidate) => candidate.id?.includes('msg_first_agent_response'));
  const pendingReplies = view.messages.filter((candidate) => candidate.turn?.status === 'processing');

  assert.equal(firstReply?.replyToMessageId, firstRequestViewId);
  assert.equal(pendingReplies.length, 1);
  assert.equal(pendingReplies[0]?.replyToMessageId, secondRequestViewId);
  assert.deepEqual(pendingReplies[0]?.turn?.pendingBridgeAgentRequest, {
    conversationId: 'bridge:cloud:acct_peer:person',
    requestId: 'msg_second_agent_request',
  });
});

test('cloud human mentions do not start cloud-agent processing UI', () => {
  const humanMention: CloudMessage = {
    ...message,
    messageId: 'msg_human_mention',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPerson hi',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [humanMention] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].outreach, null);
  assert.equal(state.conversations[0].messages[0].direction, 'outbound');
});

test('cloud incoming local-agent mentions expose synced processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_local_agent_request',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi who are you?',
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, true);
  assert.equal(state.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(state.conversations[0].outreach?.bridgeRequestId, 'msg_local_agent_request');
  assert.equal(state.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
});

test('cloud local agent runner ignores same-account self-agent sync messages', () => {
  const selfRequest: CloudMessage = {
    ...message,
    messageId: 'msg_synced_self_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: '家人们谁懂啊',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
    sessionId: 'local-self-session',
  };
  const incomingMention: CloudMessage = {
    ...message,
    messageId: 'msg_incoming_local_agent_request',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body: '@MeCloudKordi who are you?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };

  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: account.accountId,
    message: selfRequest,
    peerMessages: [selfRequest],
  }), false);
  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: incomingMention,
    peerMessages: [incomingMention],
  }), true);
});

test('cloud outgoing self-agent mentions expose localhost-style local processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloudKordi who are you?',
    direction: 'outgoing',
  };
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(pendingState.conversations[0].outreach?.bridgeRequestId, 'msg_self_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
  assert.equal(pendingState.conversations[0].outreach?.targetNodeId, 'acct_me');

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, {
      ...message,
      messageId: 'msg_self_agent_response',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: encodeCloudAgentResponse({ requestId: 'msg_self_agent_request', text: 'I am your Kordi.' }),
      direction: 'outgoing',
    }] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(answeredState.conversations[0].awaitingReply, false);
  assert.equal(answeredState.conversations[0].outreach, null);
  assert.equal(answeredState.conversations[0].messages[1].direction, 'outbound-response');
});

test('cloud outgoing remote-agent mentions stay reachable through Cloud fallback after timeout', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_offline',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi hello',
    direction: 'outgoing',
    createdAt: '2026-05-11T08:00:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, true);
  assert.equal(state.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(state.conversations[0].outreach?.bridgeRequestId, 'msg_agent_request_offline');
  const offlineMessage = state.conversations[0].messages.find((candidate) => candidate.id === 'cloud-agent-offline:msg_agent_request_offline');
  assert.equal(offlineMessage, undefined);
  const processingMessage = state.conversations[0].messages.find((candidate) => candidate.id === 'cloud-agent-processing:msg_agent_request_offline');
  assert.equal(processingMessage?.deliveryState, 'processing');

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const pendingTurn = view.messages.find((candidate) => candidate.role === 'external-agent')?.turn;
  assert.equal(pendingTurn?.status, 'processing');
});

test('cloud local owner agent treats active Cloud fallback run as already owned by Cloud', () => {
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('queued'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('leased'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('running'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('completed'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('failed'), false);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('cancelled'), false);
});

test('cloud local group owner agent detects existing Cloud fallback response for request', () => {
  const groupId = 'session:group:one';
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' as const },
  ];
  const response = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_peer',
    actor: participants[0],
    participants,
    message: {
      id: 'cloudrunmsg_group_answered',
      senderAccountId: 'acct_me',
      text: 'Already answered by Cloud.',
      createdAtMs: 2_000,
      senderKind: 'agent',
      senderDisplayName: "Me Cloud's Kordi",
      deliveryState: 'complete',
      requestId: 'msg:ui:group_request_answered_by_cloud',
      replyToMessageId: 'msg:ui:group_request_answered_by_cloud',
    },
  });

  assert.equal(cloudGroupAgentResponseExistsForRequest({
    localAccountId: 'acct_me',
    requestMessageId: 'msg:ui:group_request_answered_by_cloud',
    messages: [{
      ...message,
      messageId: 'cloudrunmsg_group_answered_row',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: response,
      direction: 'outgoing',
      sessionId: groupId,
    }],
  }), true);
});

test('cloud local owner agent detects existing Cloud fallback response for request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_request_answered_by_cloud',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you see the chathiotory?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };
  const cloudResponse: CloudMessage = {
    ...message,
    messageId: 'cloudrunmsg_answered',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Already answered by Cloud.' }),
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };

  assert.equal(cloudAgentResponseExistsForRequest({
    account,
    requestMessageId: request.messageId,
    peerMessages: [request, cloudResponse],
  }), true);
  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: request,
    peerMessages: [request, cloudResponse],
  }), false);
});

test('cloud outgoing remote-agent mentions produce Cloud fallback run claims', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_claim',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi what is todays weather',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
  }), [{
    requestMessageId: 'msg_agent_request_claim',
    sessionId: cloudDirectPersonSessionId('acct_me', 'acct_peer'),
    ownerAccountId: 'acct_peer',
    requesterAccountId: 'acct_me',
    prompt: 'what is todays weather',
    idempotencyKey: 'cloud-agent-fallback:msg_agent_request_claim:acct_peer',
  }]);
});

test('cloud outgoing group remote-agent mentions produce Cloud fallback run claims', () => {
  const groupId = 'session:group:one';
  const peerThree = cloudContactToContact({
    accountId: 'acct_three',
    displayName: 'Three Person',
    avatarUrl: null,
    nodeId: 'node_three',
    createdAt: '2026-05-11T00:00:00Z',
  });
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'admin' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' as const },
    { accountId: 'acct_three', displayName: 'Three Person', avatarUrl: null, role: 'person' as const },
  ];
  const previousBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: participants[0],
    participants,
    message: {
      id: 'msg:ui:group_previous',
      senderAccountId: 'acct_three',
      text: 'hii every one',
      createdAtMs: 1_000,
      senderKind: 'human',
    },
  });
  const requestBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: participants[0],
    participants,
    message: {
      id: 'msg:ui:group_request',
      senderAccountId: 'acct_me',
      text: '@PeerPersonKordi say hello to everyone',
      createdAtMs: 2_000,
      senderKind: 'human',
    },
  });
  const previous: CloudMessage = {
    ...message,
    messageId: 'msg_group_previous_cloud_row',
    fromAccountId: 'acct_three',
    toAccountId: 'acct_me',
    body: previousBody,
    direction: 'incoming',
    sessionId: groupId,
  };
  const requestToOwner: CloudMessage = {
    ...message,
    messageId: 'msg_group_request_owner_row',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: requestBody,
    direction: 'outgoing',
    sessionId: groupId,
  };
  const requestToParticipant: CloudMessage = {
    ...requestToOwner,
    messageId: 'msg_group_request_three_row',
    toAccountId: 'acct_three',
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer, peerThree],
    messagesByPeer: {
      acct_peer: [requestToOwner],
      acct_three: [previous, requestToParticipant],
    },
  }), [{
    requestMessageId: 'msg:ui:group_request',
    sessionId: groupId,
    ownerAccountId: 'acct_peer',
    requesterAccountId: 'acct_me',
    prompt: 'Group chat history:\nThree Person: hii every one\n\nCurrent request:\nsay hello to everyone',
    idempotencyKey: 'cloud-agent-fallback-group:session:group:one:msg:ui:group_request:acct_peer',
  }]);
});

test('cloud outgoing remote-agent mention claims include prior direct chat history', () => {
  const firstRequest: CloudMessage = {
    ...message,
    messageId: 'msg_weather_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi what is xuzhu city weather',
    direction: 'outgoing',
    createdAt: '2026-05-28T16:04:50.000Z',
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'cloudrunmsg_weather_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_weather_request', text: 'I think you mean Xuzhou city, China.' }),
    direction: 'incoming',
    createdAt: '2026-05-28T17:17:00.000Z',
  };
  const secondRequest: CloudMessage = {
    ...message,
    messageId: 'msg_check_again',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi check ahain',
    direction: 'outgoing',
    createdAt: '2026-05-28T22:30:07.000Z',
  };

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [firstRequest, firstResponse, secondRequest] },
  });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].requestMessageId, 'msg_check_again');
  assert.match(claims[0].prompt, /Conversation history:/);
  assert.match(claims[0].prompt, /Me: what is xuzhu city weather/);
  assert.match(claims[0].prompt, /Peer Person's Kordi: I think you mean Xuzhou city, China\./);
  assert.match(claims[0].prompt, /Current request:\ncheck ahain$/);
});

test('cloud outgoing remote-agent mentions expose localhost-style pending outreach UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(pendingState.conversations[0].outreach?.bridgeRequestId, 'msg_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.parentSessionId, null);

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, {
      ...message,
      messageId: 'msg_agent_response',
      fromAccountId: 'acct_peer',
      toAccountId: 'acct_me',
      body: encodeCloudAgentResponse({ requestId: 'msg_agent_request', text: 'I am Kordi.' }),
      direction: 'incoming',
    }] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(answeredState.conversations[0].awaitingReply, false);
  assert.equal(answeredState.conversations[0].outreach, null);
});

test('cloud agent optimistic cancel controls have the same shape as server cancel controls', () => {
  const cancel = optimisticCloudAgentCancelMessage({
    account,
    peerAccountId: 'acct_peer',
    requestId: 'msg_cancel_request',
    now: 1_234,
  });

  assert.equal(cancel.fromAccountId, 'acct_me');
  assert.equal(cancel.toAccountId, 'acct_peer');
  assert.equal(cancel.direction, 'outgoing');
  assert.equal(cancel.body, encodeCloudAgentCancel({ requestId: 'msg_cancel_request' }));
  assert.equal(cancel.createdAt, new Date(1_234).toISOString());
});

test('cloud group cancel finds requesting placeholders before processing reaches the agent', () => {
  const requesting = {
    id: 'msg:cloud-agent-offline:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'Requesting…',
    content: { requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: 'cloud-group-agent-offline:msg_request:acct_peer',
  } as CanonicalSessionMessage;

  assert.equal(
    cloudGroupAgentProcessingMessageForRequest([requesting], 'session:group', 'msg_request')?.id,
    requesting.id,
  );
});

test('cloud group terminal responses reuse an existing peer processing slot', () => {
  const processing = {
    id: 'msg:cloud-agent-processing:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: { sender: "Peer's Kordi", requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:msg:cloud-agent-processing:msg_request:acct_peer',
  } as CanonicalSessionMessage;
  const unrelatedOtherAgentProcessing = {
    ...processing,
    id: 'msg:cloud-agent-processing:msg_request:acct_other',
    senderIdentityId: 'agent:cloud:acct_other',
  } as CanonicalSessionMessage;

  assert.equal(
    cloudGroupAgentProcessingSlotForResponse(
      [unrelatedOtherAgentProcessing, processing],
      'session:group',
      'msg_request',
      'acct_peer',
    )?.id,
    processing.id,
  );
});

test('cloud group cancel notices record sender or agent owner role', () => {
  const processing = {
    id: 'msg:cloud-agent-offline:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: { sender: "Peer's Kordi", requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: 'cloud-group-agent-offline:msg_request:acct_peer',
  } as CanonicalSessionMessage;
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile', displayName: 'Me', humanIdentityId: 'human:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', humanId: 'acct_me', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [],
    participants: [],
    messages: [
      { id: 'msg_request', sessionId: 'session:group', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeerKordi hi', content: {}, status: 'sent', sequenceNum: 0, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'request' },
      processing,
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as CanonicalSessionState;

  assert.equal(cloudGroupAgentCancelRoleForRequest({ state: canonicalState, requestId: 'msg_request', processingMessage: processing, cancelledByAccountId: 'acct_me' }), 'sender');
  assert.equal(cloudGroupAgentCancelRoleForRequest({ state: canonicalState, requestId: 'msg_request', processingMessage: processing, cancelledByAccountId: 'acct_peer' }), 'agent owner');

  const notice = cloudGroupAgentCancelledNoticeRequest({
    processingMessage: processing,
    requestId: 'msg_request',
    conversationId: 'cloud-group-agent:session:group',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
    now: 1_234,
  });

  assert.equal(notice.contentText, 'Request canceled by sender.');
  assert.deepEqual(notice.content, {
    sender: "Peer's Kordi",
    timestampMs: 1_234,
    deliveryState: 'cancelled',
    bridgeConversationId: 'cloud-group-agent:session:group',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
  });
});

test('cloud group cancel notices default to the stable processing timestamp', () => {
  const notice = cloudGroupAgentCancelledNoticeRequest({
    processingMessage: {
      id: 'msg:processing',
      sessionId: 'session:group',
      senderIdentityId: 'agent:peer',
      senderRole: 'external-agent',
      messageKind: 'agent-turn',
      contentText: 'Requesting…',
      content: { sender: "Peer's Kordi", timestampMs: 55_000, deliveryState: 'processing', requestId: 'msg_request' },
      status: 'processing',
      sequenceNum: 1,
      createdAtMs: 44_000,
      updatedAtMs: 44_000,
      contentHash: null,
      sourceTransport: 'cloud-group-agent-offline',
      sourceEventId: 'processing',
    } as CanonicalSessionMessage,
    requestId: 'msg_request',
    conversationId: 'cloud-group-agent:session:group',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
  });

  assert.equal(notice.createdAtMs, 55_000);
  assert.equal((notice.content as { timestampMs?: number }).timestampMs, 55_000);
});

test('cloud agent cancel controls are hidden and show who cancelled the request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_cancel_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
  };
  const cancel: CloudMessage = {
    ...message,
    messageId: 'msg_cancel_control',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentCancel({ requestId: 'msg_cancel_request' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, cancel] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].messages.length, 2);
  assert.equal(state.conversations[0].messages[0].deliveryState, 'cancelled');
  assert.equal(state.conversations[0].messages[1].deliveryState, 'cancelled');
  assert.equal(view.messages[1]?.turn?.status, 'cancelled');
  assert.equal(view.messages[1]?.turn?.assistantText, 'Request canceled by sender.');
});

test('cloud outgoing messages render as read when the peer read timestamp is present', () => {
  const readOutgoing: CloudMessage = {
    ...message,
    messageId: 'msg_read',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hi',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: '2026-05-11T10:00:02Z',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readOutgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'read');
});
