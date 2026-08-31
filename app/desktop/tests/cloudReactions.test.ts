import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  canonicalMessageReactionMetadata,
  mergedMessageReactionMetadata,
} from '../src/features/canonical/readModel/messageReactionMetadata';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import {
  buildCloudMessageIndex,
  patchCanonicalCloudReactions,
} from '../src/features/cloud/cloudMessageIndex';
import {
  cloudReactionMutationTargets,
  createCloudReactionMutationQueue,
  mergeCloudMessageReactionResponse,
  updateCloudMessageReaction,
} from '../src/features/cloud/cloudReactionMutations';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { messageBubblePinnedIdsEqual } from '../src/kordi-app/components/messageBubbleMemo';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const message: CloudMessage = {
  messageId: 'message-id',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello',
  createdAt: '2026-08-29T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
  conversationId: 'conversation-id',
  version: 1,
  reactions: [],
};

test('reaction updates are optimistic and reaction-only sync events survive normalization', () => {
  const optimistic = updateCloudMessageReaction(
    { acct_peer: [message] },
    'acct_me',
    {
      conversationId: 'conversation-id',
      messageId: 'message-id',
      reaction: '👍',
      active: true,
    },
  );
  assert.deepEqual(optimistic.acct_peer?.[0]?.reactions, [{ value: '👍', accountIds: ['acct_me'] }]);

  const synced = applyCloudSyncEventsToMessagesByPeer('acct_me', optimistic, [{
    eventId: 'reaction-event',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'message-id',
    occurredAt: '2026-08-29T10:01:00Z',
    payload: {
      message: {
        ...message,
        reactions: [{ value: '👍', accountIds: ['acct_peer'] }],
      },
    },
  }]);
  assert.deepEqual(synced.acct_peer?.[0]?.reactions, [{
    value: '👍',
    accountIds: ['acct_me', 'acct_peer'],
  }]);
  assert.equal(synced.acct_peer?.[0]?.version, 1);

  const responseMerged = mergeCloudMessageReactionResponse(
    synced,
    {
      conversationId: 'conversation-id',
      messageId: 'message-id',
      reaction: '👍',
      active: true,
    },
    {
      ...message,
      reactions: [{ value: '👍', accountIds: ['acct_me', 'acct_peer'] }],
    },
  );
  assert.equal(responseMerged.acct_peer?.[0]?.pendingReactionIntents, undefined);

  const confirmedAdd = applyCloudSyncEventsToMessagesByPeer('acct_me', responseMerged, [{
    eventId: 'confirmed-add-event',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'message-id',
    occurredAt: '2026-08-29T10:01:01Z',
    payload: {
      reactionStateConfirmed: true,
      message: {
        ...message,
        reactions: [{ value: '👍', accountIds: ['acct_me', 'acct_peer'] }],
      },
    },
  }]);
  assert.equal(confirmedAdd.acct_peer?.[0]?.pendingReactionIntents, undefined);

  const removing = updateCloudMessageReaction(
    confirmedAdd,
    'acct_me',
    {
      conversationId: 'conversation-id',
      messageId: 'message-id',
      reaction: '👍',
      active: false,
    },
  );
  const staleAdd = applyCloudSyncEventsToMessagesByPeer('acct_me', removing, [{
    eventId: 'stale-add-event',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'message-id',
    occurredAt: '2026-08-29T10:02:00Z',
    payload: {
      message: {
        ...message,
        reactions: [{ value: '👍', accountIds: ['acct_me', 'acct_peer'] }],
      },
    },
  }]);
  assert.deepEqual(staleAdd.acct_peer?.[0]?.reactions, [{ value: '👍', accountIds: ['acct_peer'] }]);
  assert.deepEqual(staleAdd.acct_peer?.[0]?.pendingReactionIntents, [{
    value: '👍',
    accountId: 'acct_me',
    active: false,
  }]);

  const confirmedRemove = applyCloudSyncEventsToMessagesByPeer('acct_me', staleAdd, [{
    eventId: 'confirmed-remove-event',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'message-id',
    occurredAt: '2026-08-29T10:02:01Z',
    payload: {
      reactionStateConfirmed: true,
      message: {
        ...message,
        reactions: [{ value: '👍', accountIds: ['acct_peer'] }],
      },
    },
  }]);
  assert.equal(confirmedRemove.acct_peer?.[0]?.pendingReactionIntents, undefined);
});

test('rapid reaction mutations serialize and only commit the latest intent', async () => {
  const enqueue = createCloudReactionMutationQueue();
  const releases: Array<(message: CloudMessage) => void> = [];
  const starts: boolean[] = [];
  const commits: boolean[] = [];
  const mutate = (active: boolean) => () => new Promise<CloudMessage>((resolve) => {
    starts.push(active);
    releases.push((value) => resolve(value));
  });
  const first = enqueue('reaction', mutate(true), () => commits.push(true), () => undefined);
  const second = enqueue('reaction', mutate(false), () => commits.push(false), () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [true]);
  releases.shift()?.({ ...message, reactions: [{ value: '👍', accountIds: ['acct_me'] }] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [true, false]);
  assert.deepEqual(commits, []);
  releases.shift()?.({ ...message, reactions: [] });
  await Promise.all([first, second]);
  assert.deepEqual(commits, [false]);
});

test('reaction-only changes invalidate desktop projections and reach canonical group messages', () => {
  const groupId = 'session:group:reaction';
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupTitle: 'Reaction group',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' }],
    message: {
      id: 'canonical-message-id',
      senderAccountId: 'acct_peer',
      text: 'hello',
      createdAtMs: Date.parse(message.createdAt),
    },
  });
  const wire = {
    ...message,
    body,
    sessionId: groupId,
    reactions: [{ value: '👍', accountIds: ['acct_me', 'acct_peer'] }],
  };
  const withoutReaction = buildCloudMessageIndex('acct_me', {
    acct_peer: [{ ...wire, reactions: [] }],
  });
  const withReaction = buildCloudMessageIndex('acct_me', { acct_peer: [wire] });
  assert.notEqual(
    withoutReaction.sessionRevisionBySessionId.get(groupId),
    withReaction.sessionRevisionBySessionId.get(groupId),
  );
  const duplicate = {
    ...wire,
    messageId: 'aaa-copy-id',
    reactions: [{ value: '👍', accountIds: ['acct_me'] }],
  };
  const removal = {
    conversationId: 'conversation-id',
    messageId: 'message-id',
    reaction: '👍',
    active: false,
  };
  assert.deepEqual(
    cloudReactionMutationTargets({ acct_peer: [duplicate, wire] }, 'acct_me', removal)
      .map((target) => target.messageId)
      .sort(),
    ['aaa-copy-id', 'message-id'],
  );
  const pendingRemoval = updateCloudMessageReaction(
    { acct_peer: [duplicate, wire] },
    'acct_me',
    removal,
  );
  const pendingIndex = buildCloudMessageIndex('acct_me', pendingRemoval);

  const state: CanonicalSessionState = {
    profile: { id: 'profile:me', humanIdentityId: 'human:me' },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'canonical-message-id',
      sessionId: groupId,
      senderIdentityId: 'human:peer',
      senderRole: 'person',
      messageKind: 'text',
      contentText: 'hello',
      contentHash: 'hash',
      content: {},
      createdAtMs: Date.parse(message.createdAt),
      updatedAtMs: Date.parse(message.createdAt),
      parentMessageId: null,
      status: 'received',
      sourceTransport: 'cloud-group',
      sourceEventId: 'cloud-group:message-id',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const fallback = canonicalMessageReactionMetadata(state.messages[0]!, {}, 'cloud-group');
  assert.equal(fallback.reactionConversationId, groupId);
  assert.equal(fallback.reactionTargetMessageId, 'canonical-message-id');
  const wireFallback = canonicalMessageReactionMetadata({
    ...state.messages[0]!,
    sourceEventId: 'cloud-group:018f47c2-9f4c-7a5e-b001-000000000001',
  }, {}, 'cloud-group');
  assert.equal(
    wireFallback.reactionTargetMessageId,
    '018f47c2-9f4c-7a5e-b001-000000000001',
  );
  const patched = patchCanonicalCloudReactions(state, pendingIndex.groupRows);
  const canonical = patched?.messages[0];
  const metadata = canonicalMessageReactionMetadata(
    canonical!,
    canonical?.content as Record<string, unknown>,
    'cloud-group',
  );
  assert.equal(metadata.reactionConversationId, 'conversation-id');
  assert.equal(metadata.reactionTargetMessageId, 'message-id');
  assert.deepEqual(metadata.reactions, [{ value: '👍', accountIds: ['acct_peer'] }]);
  const cleared = mergedMessageReactionMetadata({
    id: 'canonical-message-id',
    role: 'user',
    text: 'hello',
    time: '10:00',
    reactions: [{ value: '👍', accountIds: ['acct_me'] }],
  }, {
    id: 'canonical-message-id',
    role: 'user',
    text: 'hello',
    time: '10:00',
    reactions: [],
  });
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.values.reactions, []);
  assert.equal(
    patchCanonicalCloudReactions(patched, pendingIndex.groupRows),
    patched,
  );
});

test('canonical reactions are a derived read-only workspace projection', () => {
  const reconciliation = readFileSync(
    new URL('../src/features/cloud/useCloudCanonicalReconciliation.ts', import.meta.url),
    'utf8',
  );
  const cloudState = readFileSync(
    new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url),
    'utf8',
  );
  const workspace = readFileSync(
    new URL('../src/app/useKordiWorkspaceState.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(reconciliation, /patchCanonicalCloudReactions/);
  assert.match(cloudState, /cloudCanonicalReactionState = useMemo\(\(\) => patchCanonicalCloudMessages/);
  assert.match(workspace, /canonicalSessionState: cloudCanonicalReactionState \?\? canonicalSessionState/);
});

test('message reaction selection dismisses the action menu immediately', () => {
  const source = readFileSync(
    new URL('../src/kordi-app/components/messageContextMenuContent.tsx', import.meta.url),
    'utf8',
  );
  const handler = source.slice(
    source.indexOf('const handleReaction'),
    source.indexOf('const reviewMediaAttachment'),
  );

  assert.ok(handler.indexOf('onClose?.()') < handler.indexOf('onReactMessage?.(msg, reaction)'));
});

test('reaction-only updates keep equivalent pin ids memoized', () => {
  assert.equal(messageBubblePinnedIdsEqual([], []), true);
  assert.equal(messageBubblePinnedIdsEqual(['message'], ['message']), true);
  assert.equal(messageBubblePinnedIdsEqual(['message'], ['other']), false);
});
