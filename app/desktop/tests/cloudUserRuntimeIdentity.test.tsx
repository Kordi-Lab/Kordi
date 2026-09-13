import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/runtimeHistoryMerge';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

function canonical(id: string, content: object = {}) {
  const row: CanonicalSessionMessage = { id: `canonical:${id}`, sessionId: 'session:test', senderIdentityId: 'human:test',
    senderRole: 'user', messageKind: 'text', contentText: 'Test message', content, status: 'sent', sequenceNum: 1,
    createdAtMs: 59_000, updatedAtMs: 59_000, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: id };
  return mapCanonicalMessage(row, new Map(), 'human:test')!;
}
function runtime(id: string) {
  return mapDesktopMessagesForTranscript('session:test', [{ role: 'user', entryId: id, text: 'Test message',
    timeLabel: 'next minute', timestampMs: 68_000 }])[0];
}

test('a cloud send and its delayed runtime import use one identity before alias enrichment', () => {
  const cloud = canonical('wire:one');
  const local = runtime('wire:one');
  assert.notEqual(cloud.time, local.time);
  assert.equal(mergeCanonicalHistoryIntoRuntime([cloud], [local]).length, 1);
});

test('hydrating the desktop alias does not change the number of visible user messages', () => {
  const local = runtime('wire:one');
  for (const content of [{}, { desktopEntryId: 'wire:one' }]) {
    assert.equal(mergeCanonicalHistoryIntoRuntime([canonical('wire:one', content)], [local]).length, 1);
  }
});

test('two intentional sends with identical text retain their separate wire identities', () => {
  const merged = mergeCanonicalHistoryIntoRuntime([canonical('wire:one'), canonical('wire:two')],
    [runtime('wire:one'), runtime('wire:two')]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((message) => message.entryId), ['wire:one', 'wire:two']);
});
