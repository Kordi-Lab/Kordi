import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { prepareCanonicalUserMessage } from '../src/features/chat/messageActions/optimistic';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const state: CanonicalSessionState = {
  profile: { id: 'profile:me', humanIdentityId: 'human:me' },
  identities: [
    { id: 'human:me', kind: 'human', displayName: 'Me', ownerIdentityId: null, source: 'local', sourceHostId: null, bridgeNodeId: null, humanId: 'acct_me', agentId: null, avatarKey: null, profileImageUrl: null, metadata: {}, createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [
    { id: 'session:main', kind: 'group', title: 'Main', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, createdAtMs: 1, updatedAtMs: 1 },
  ],
  participants: [],
  messages: [],
  delegatedExchanges: [],
  presence: [],
  contextSnapshots: [],
};

test('prepareCanonicalUserMessage stores quote metadata and parent message id', () => {
  const prepared = prepareCanonicalUserMessage(
    'session:main',
    'human:me',
    'Reply with context',
    [],
    '10:30',
    'desktop-chat-ui',
    'sending',
    [],
    {
      quote: {
        messageId: 'msg:source',
        senderLabel: 'Alice',
        text: 'Original context',
        time: '10:29',
      },
    },
  );

  assert.ok(prepared);
  assert.equal(prepared.request.parentMessageId, 'msg:source');
  assert.deepEqual((prepared.request.content as Record<string, unknown>).quote, {
    messageId: 'msg:source',
    senderLabel: 'Alice',
    text: 'Original context',
    time: '10:29',
  });
});

test('prepareCanonicalUserMessage stores forwarded metadata', () => {
  const prepared = prepareCanonicalUserMessage(
    'session:main',
    'human:me',
    'Forwarded body',
    [],
    '10:31',
    'desktop-chat-ui',
    'sending',
    [],
    {
      forwardedFrom: {
        sourceMessageId: 'msg:news',
        sourceSessionId: 'session:news',
        senderLabel: 'Odaily资讯速递',
        sourceChatLabel: 'News',
      },
    },
  );

  assert.ok(prepared);
  assert.equal(prepared.request.parentMessageId, null);
  assert.deepEqual((prepared.request.content as Record<string, unknown>).forwardedFrom, {
    sourceMessageId: 'msg:news',
    sourceSessionId: 'session:news',
    senderLabel: 'Odaily资讯速递',
    sourceChatLabel: 'News',
  });
});

test('canonical read model maps quote and forwarded metadata onto Message', () => {
  const indexes = buildCanonicalIndexes(state);
  const message = mapCanonicalMessage({
    id: 'msg:forwarded',
    sessionId: 'session:main',
    senderIdentityId: 'human:me',
    senderRole: 'user',
    messageKind: 'text',
    contentText: 'Forwarded body',
    content: {
      sender: 'Me',
      timestampMs: 1,
      quote: { messageId: 'msg:source', senderLabel: 'Alice', text: 'Original context', time: '10:29' },
      forwardedFrom: { sourceMessageId: 'msg:news', sourceSessionId: 'session:news', senderLabel: 'Odaily资讯速递', sourceChatLabel: 'News' },
    },
    parentMessageId: 'msg:source',
    delegatedExchangeId: null,
    status: 'sent',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'desktop-chat-ui',
    sourceEventId: 'desktop-chat-ui:test',
  }, indexes.identityById, state.profile.humanIdentityId);

  assert.equal(message?.quote?.messageId, 'msg:source');
  assert.equal(message?.quote?.senderLabel, 'Alice');
  assert.equal(message?.forwardedFrom?.sourceMessageId, 'msg:news');
  assert.equal(message?.forwardedFrom?.senderLabel, 'Odaily资讯速递');
});
