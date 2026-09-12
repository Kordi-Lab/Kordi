import { performance } from 'node:perf_hooks';
import { mergeCloudMessagesByPeerSnapshot } from '../src/features/cloud/cloudMessageSyncState';
import { buildScaleCloudMessagesByPeer } from '../tests/fixtures/chatScale';

const current = buildScaleCloudMessagesByPeer();
const peerId = Object.keys(current)[0];
const messages = current[peerId];
const last = messages[messages.length - 1];
const incoming = {
  ...current,
  [peerId]: [...messages.slice(0, -1), { ...last, body: `${last.body} updated` }],
};

function medianMs(operation: () => unknown) {
  const durations: number[] = [];
  for (let run = 0; run < 12; run += 1) {
    const start = performance.now();
    operation();
    if (run >= 2) durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  return Number(((durations[4] + durations[5]) / 2).toFixed(4));
}

process.stdout.write(`${JSON.stringify({
  messages: Object.values(current).reduce((count, rows) => count + rows.length, 0),
  unchangedMergeMs: medianMs(() => mergeCloudMessagesByPeerSnapshot(current, current)),
  singlePeerChangeMs: medianMs(() => mergeCloudMessagesByPeerSnapshot(current, incoming)),
})}\n`);
