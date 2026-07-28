import { performance } from 'node:perf_hooks';

import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import {
  buildCloudMessageIndex,
} from '../src/features/cloud/cloudMessageIndex';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import {
  CHAT_SCALE,
  SCALE_ACCOUNT_ID,
  buildScaleCollaborationConversation,
  buildScaleCanonicalState,
  buildScaleCloudMessagesByPeer,
  scaleMessageId,
} from '../tests/fixtures/chatScale';
import {
  CHAT_SCALE_BENCHMARK_BUDGETS,
  chatScaleBenchmarkBudgetFailures,
  type ChatScaleBenchmarkBudgets,
} from './chat-scale-budget';

type ChatScaleBenchmark = {
  collaborationMapMs: number;
  canonicalIndexMs: number;
  cloudIndexMs: number;
  cloudIndexDeltaMs: number;
  cloudDeliveryLookupMs: number;
  serializedCacheBytes: number;
  fixture: {
    spaces: number;
    sessions: number;
    canonicalMessages: number;
    selectedSessionMessages: number;
    cloudRows: number;
    cloudRecipients: number;
  };
  budgets: ChatScaleBenchmarkBudgets;
  budgetFailures: string[];
  passed: boolean;
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
const collaborationConversation = buildScaleCollaborationConversation();
const messagesByPeer = buildScaleCloudMessagesByPeer();
const deliveryLookupIds = Array.from(
  { length: 1 },
  (_, index) => scaleMessageId(0, CHAT_SCALE.messagesPerSession + index),
);

let mappedCollaborationMessageCount = 0;
const collaborationMapMs = benchmark(() => {
  mappedCollaborationMessageCount = mapCollaborationConversationToViewModel(
    collaborationConversation,
    undefined,
    'My Kordi',
  ).messages.length;
});
if (mappedCollaborationMessageCount !== CHAT_SCALE.selectedSessionMessages - 50) {
  throw new Error(`Unexpected mapped collaboration message count: ${mappedCollaborationMessageCount}`);
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

const deltaPeerId = 'acct_scale_0';
const deltaPeerMessages = messagesByPeer[deltaPeerId] ?? [];
const deltaTemplate = deltaPeerMessages.at(-1);
if (!deltaTemplate) throw new Error('Scale fixture is missing the delta template row.');
const messagesByPeerWithDelta = {
  ...messagesByPeer,
  [deltaPeerId]: [
    ...deltaPeerMessages,
    {
      ...deltaTemplate,
      messageId: 'wire:scale:delta',
      createdAt: '2026-01-02T00:00:00.000Z',
      deliveredAt: '2026-01-02T00:00:01.000Z',
      readAt: null,
    },
  ],
};
let deltaParseCalls = 0;
const cloudIndexDeltaMs = benchmark(() => {
  deltaParseCalls = 0;
  buildCloudMessageIndex(SCALE_ACCOUNT_ID, messagesByPeerWithDelta, {
    previousIndex: cloudMessageIndex,
    parseGroupControl(body) {
      deltaParseCalls += 1;
      return parseCloudGroupControl(body);
    },
  });
});
if (deltaParseCalls !== 1) {
  throw new Error(`Unexpected incremental Cloud parse count: ${deltaParseCalls}`);
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
  collaborationMapMs,
  canonicalIndexMs,
  cloudIndexMs,
  cloudIndexDeltaMs,
  cloudDeliveryLookupMs,
  serializedCacheBytes: new TextEncoder().encode(JSON.stringify(messagesByPeer)).byteLength,
  fixture: {
    spaces: CHAT_SCALE.spaces,
    sessions: CHAT_SCALE.sessions,
    canonicalMessages: canonicalState.messages.length,
    selectedSessionMessages: CHAT_SCALE.selectedSessionMessages,
    cloudRows: cloudMessageIndex.allMessages.length,
    cloudRecipients: CHAT_SCALE.cloudRecipients,
  },
  budgets: CHAT_SCALE_BENCHMARK_BUDGETS,
  budgetFailures: [],
  passed: false,
};

output.budgetFailures = chatScaleBenchmarkBudgetFailures(output);
output.passed = output.budgetFailures.length === 0;

console.log(JSON.stringify(output));
if (!output.passed) process.exitCode = 1;
