import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import {
  buildCloudMessageIndex,
  canonicalMessageSourceKey,
  cloudGroupCanonicalMessageSource,
  cloudGroupReplayRowsAfterDurableHistory,
  patchCanonicalDeliverySummaries,
} from '../src/features/cloud/cloudMessageIndex';
import {
  CHAT_SCALE,
  SCALE_ACCOUNT_ID,
  buildScaleCanonicalState,
  buildScaleCloudMessagesByPeer,
  scaleMessageId,
} from './fixtures/chatScale';

test('scale Cloud fixture has deterministic full fanout and valid group envelopes', () => {
  const messagesByPeer = buildScaleCloudMessagesByPeer();
  const peerIds = Object.keys(messagesByPeer);

  assert.equal(peerIds.length, CHAT_SCALE.cloudRecipients);
  assert.deepEqual(peerIds, Array.from(
    { length: CHAT_SCALE.cloudRecipients },
    (_, index) => `acct_scale_${index}`,
  ));

  const allMessages = Object.values(messagesByPeer).flat();
  assert.equal(
    allMessages.length,
    CHAT_SCALE.selectedSessionMessages * CHAT_SCALE.cloudRecipients,
  );
  assert.ok(Object.values(messagesByPeer).every(
    (messages) => messages.length === CHAT_SCALE.selectedSessionMessages,
  ));

  const firstEnvelope = parseCloudGroupControl(messagesByPeer.acct_scale_0?.[0]?.body ?? '');
  const lastEnvelope = parseCloudGroupControl(messagesByPeer.acct_scale_19?.at(-1)?.body ?? '');
  assert.equal(firstEnvelope?.message?.id, scaleMessageId(0, CHAT_SCALE.messagesPerSession));
  assert.equal(
    lastEnvelope?.message?.id,
    scaleMessageId(0, CHAT_SCALE.messagesPerSession + CHAT_SCALE.selectedSessionMessages - 1),
  );
  assert.equal(messagesByPeer.acct_scale_0?.[0]?.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(messagesByPeer.acct_scale_0?.[0]?.direction, 'outgoing');
  assert.equal(messagesByPeer.acct_scale_0?.[0]?.readAt, '2026-01-01T00:00:02.000Z');
});

test('Cloud message index parses each unique wire row once and builds constant-time delivery summaries', () => {
  const fixture = buildScaleCloudMessagesByPeer();
  const messagesByPeer = Object.fromEntries(Object.entries(fixture).map(([peerId, messages]) => (
    [peerId, messages.slice(0, 25)]
  )));
  messagesByPeer.acct_scale_1 = [
    ...(messagesByPeer.acct_scale_1 ?? []),
    messagesByPeer.acct_scale_0[0]!,
  ];
  let parseCalls = 0;
  const index = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer, {
    parseGroupControl(body) {
      parseCalls += 1;
      return parseCloudGroupControl(body);
    },
  });

  assert.equal(index.allMessages.length, 500);
  assert.equal(parseCalls, index.allMessages.length);
  assert.equal(index.groupRows.length, index.allMessages.length);
  assert.equal(index.deliveryByMessageId.get(scaleMessageId(0, 100))?.state, 'read');
  assert.equal(index.deliveryByMessageId.get(scaleMessageId(0, 100))?.readers.length, 7);
});

test('a less complete duplicate cannot erase a semantic message kind', () => {
  const template = buildScaleCloudMessagesByPeer().acct_scale_0[0]!;
  const semantic = {
    ...template,
    messageId: 'wire:semantic-kind',
    messageKind: 'agent-model-change',
  };
  const compatibilityDuplicate = {
    ...semantic,
    messageKind: undefined,
    deliveredAt: '2026-01-01T00:00:03.000Z',
  };
  const index = buildCloudMessageIndex(SCALE_ACCOUNT_ID, {
    acct_scale_0: [semantic],
    acct_scale_1: [compatibilityDuplicate],
  });

  assert.equal(index.byMessageId.get(semantic.messageId)?.messageKind, 'agent-model-change');
});

test('a one-row Cloud delta reuses parsed envelopes from the 20,000-row index', () => {
  const messagesByPeer = buildScaleCloudMessagesByPeer();
  const previousIndex = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer);
  const peerId = 'acct_scale_0';
  const previousRows = messagesByPeer[peerId] ?? [];
  const template = previousRows.at(-1)!;
  const nextMessagesByPeer = {
    ...messagesByPeer,
    [peerId]: [
      ...previousRows,
      {
        ...template,
        messageId: 'wire:scale:incremental',
        createdAt: '2026-01-02T00:00:00.000Z',
        deliveredAt: '2026-01-02T00:00:01.000Z',
        readAt: null,
      },
    ],
  };
  let parseCalls = 0;
  const nextIndex = buildCloudMessageIndex(SCALE_ACCOUNT_ID, nextMessagesByPeer, {
    previousIndex,
    parseGroupControl(body) {
      parseCalls += 1;
      return parseCloudGroupControl(body);
    },
  });

  assert.equal(nextIndex.allMessages.length, previousIndex.allMessages.length + 1);
  assert.equal(parseCalls, 1);
  assert.equal(nextIndex.groupRows.length, previousIndex.groupRows.length + 1);
  for (let index = 0; index < previousIndex.groupRows.length; index += 1) {
    assert.equal(
      nextIndex.groupRows[index],
      previousIndex.groupRows[index],
      `Expected existing row ${index} to retain its parsed envelope and object identity`,
    );
  }
});

test('an unchanged Cloud message store reuses the complete index by identity', () => {
  const messagesByPeer = buildScaleCloudMessagesByPeer();
  const previousIndex = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer);
  let parseCalls = 0;
  const nextIndex = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer, {
    previousIndex,
    parseGroupControl(body) {
      parseCalls += 1;
      return parseCloudGroupControl(body);
    },
  });

  assert.equal(nextIndex, previousIndex);
  assert.equal(parseCalls, 0);
});

test('durable Cloud group history keeps one compact preparation row per group', () => {
  const messagesByPeer = buildScaleCloudMessagesByPeer();
  const index = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer);
  const existingSourceKeys = new Set(index.replayRows.flatMap((row) => {
    const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
    return source ? [canonicalMessageSourceKey(source)] : [];
  }));
  const replayRows = cloudGroupReplayRowsAfterDurableHistory(
    index.replayRows,
    existingSourceKeys,
  );
  const messageGroupIds = new Set(index.replayRows.flatMap((row) => (
    cloudGroupCanonicalMessageSource(row.wire, row.envelope)
      ? [row.envelope.groupId]
      : []
  )));

  assert.equal(replayRows.length, messageGroupIds.size);
  assert.deepEqual(
    new Set(replayRows.map((row) => row.envelope.groupId)),
    messageGroupIds,
  );
});

test('updated Cloud group messages use a new durable replay source', () => {
  const wire = buildScaleCloudMessagesByPeer().acct_scale_0[0]!;
  const envelope = parseCloudGroupControl(wire.body)!;

  assert.equal(
    cloudGroupCanonicalMessageSource(wire, envelope)?.sourceEventId,
    `cloud-group:${wire.messageId}`,
  );
  assert.equal(
    cloudGroupCanonicalMessageSource({ ...wire, version: 2 }, envelope)?.sourceEventId,
    `cloud-group:${wire.messageId}:2`,
  );
});

test('canonical delivery patch preserves state identity after summaries are applied', () => {
  const messagesByPeer = buildScaleCloudMessagesByPeer();
  const index = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer);
  const state = buildScaleCanonicalState();
  const patched = patchCanonicalDeliverySummaries(state, index.deliveryByMessageId);

  assert.notEqual(patched, state);
  const message = patched?.messages.find((candidate) => candidate.id === scaleMessageId(0, 100));
  const content = message?.content as Record<string, unknown> | undefined;
  const readReceiptSummary = content?.readReceiptSummary as { count?: number } | undefined;
  assert.equal(message?.status, 'sent');
  assert.equal(content?.deliveryState, 'read');
  assert.equal(readReceiptSummary?.count, 7);
  assert.equal(patchCanonicalDeliverySummaries(patched, index.deliveryByMessageId), patched);
});
