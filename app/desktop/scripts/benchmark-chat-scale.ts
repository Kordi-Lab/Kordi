import { performance } from 'node:perf_hooks';

import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import {
  buildCloudMessageIndex,
} from '../src/features/cloud/cloudMessageIndex';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import {
  CHAT_SCALE,
  SCALE_ACCOUNT_ID,
  buildScaleBridgeConversation,
  buildScaleCanonicalState,
  buildScaleCloudMessagesByPeer,
  scaleMessageId,
} from '../tests/fixtures/chatScale';

type ChatScaleBenchmark = {
  bridgeMapMs: number;
  canonicalIndexMs: number;
  cloudIndexMs: number;
  cloudDeliveryLookupMs: number;
  serializedCacheBytes: number;
};

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function benchmark(operation: () => void) {
  const durations: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  return Number(median(durations.slice(1)).toFixed(3));
}

const canonicalState = buildScaleCanonicalState();
const bridgeConversation = buildScaleBridgeConversation();
const messagesByPeer = buildScaleCloudMessagesByPeer();
const deliveryLookupIds = Array.from(
  { length: 1 },
  (_, index) => scaleMessageId(0, CHAT_SCALE.messagesPerSession + index),
);

let mappedBridgeMessageCount = 0;
const bridgeMapMs = benchmark(() => {
  mappedBridgeMessageCount = mapBridgeConversationToViewModel(
    bridgeConversation,
    undefined,
    'My Kordi',
  ).messages.length;
});
if (mappedBridgeMessageCount !== CHAT_SCALE.selectedSessionMessages - 50) {
  throw new Error(`Unexpected mapped Bridge message count: ${mappedBridgeMessageCount}`);
}

let indexedCanonicalSessionCount = 0;
const canonicalIndexMs = benchmark(() => {
  indexedCanonicalSessionCount = buildCanonicalIndexes(canonicalState).sessionById.size;
});
if (indexedCanonicalSessionCount !== CHAT_SCALE.sessions) {
  throw new Error(`Unexpected canonical session count: ${indexedCanonicalSessionCount}`);
}

let indexedCloudMessageCount = 0;
let cloudMessageIndex = buildCloudMessageIndex(null, {});
const cloudIndexMs = benchmark(() => {
  cloudMessageIndex = buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeer);
  indexedCloudMessageCount = cloudMessageIndex.replayRows.length;
});
if (indexedCloudMessageCount !== CHAT_SCALE.selectedSessionMessages) {
  throw new Error(`Unexpected indexed Cloud message count: ${indexedCloudMessageCount}`);
}

let resolvedDeliveryCount = 0;
const cloudDeliveryLookupMs = benchmark(() => {
  resolvedDeliveryCount = deliveryLookupIds.filter((messageId) => (
    cloudMessageIndex.deliveryByMessageId.get(messageId)?.state === 'read'
  )).length;
});
if (resolvedDeliveryCount !== deliveryLookupIds.length) {
  throw new Error(`Unexpected Cloud delivery lookup count: ${resolvedDeliveryCount}`);
}

const output: ChatScaleBenchmark = {
  bridgeMapMs,
  canonicalIndexMs,
  cloudIndexMs,
  cloudDeliveryLookupMs,
  serializedCacheBytes: new TextEncoder().encode(JSON.stringify(messagesByPeer)).byteLength,
};

console.log(JSON.stringify(output));
