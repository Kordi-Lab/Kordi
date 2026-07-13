import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import {
  buildCloudMessageIndex,
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
  const startedAt = performance.now();
  const index = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer, {
    parseGroupControl(body) {
      parseCalls += 1;
      return parseCloudGroupControl(body);
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(index.allMessages.length, 500);
  assert.equal(parseCalls, index.allMessages.length);
  assert.equal(index.groupRows.length, index.allMessages.length);
  assert.equal(index.deliveryByMessageId.get(scaleMessageId(0, 100))?.state, 'read');
  assert.equal(index.deliveryByMessageId.get(scaleMessageId(0, 100))?.readers.length, 7);
  assert.ok(elapsedMs < 100, `Expected 500-row index below 100ms, received ${elapsedMs.toFixed(1)}ms`);
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
  const startedAt = performance.now();
  const nextIndex = buildCloudMessageIndex(SCALE_ACCOUNT_ID, nextMessagesByPeer, {
    previousIndex,
    parseGroupControl(body) {
      parseCalls += 1;
      return parseCloudGroupControl(body);
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(nextIndex.allMessages.length, previousIndex.allMessages.length + 1);
  assert.equal(parseCalls, 1);
  assert.ok(elapsedMs < 50, `Expected one-row index delta below 50ms, received ${elapsedMs.toFixed(1)}ms`);
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
