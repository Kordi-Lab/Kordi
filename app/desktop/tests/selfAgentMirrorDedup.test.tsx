import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfAgentMirrorDuplicateIds } from '../src/features/canonical/readModel/selfAgentMirrorDedup';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/runtimeHistoryMerge';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const identities = new Map<string, CanonicalIdentity>([
  ['agent:test', { id: 'agent:test', kind: 'agent', displayName: 'Test agent', source: 'local', ownerIdentityId: 'human:test', createdAtMs: 1, updatedAtMs: 1 }],
]);
function response(overrides: Partial<CanonicalSessionMessage> = {}): CanonicalSessionMessage {
  return { id: 'cloud:terminal', sessionId: 'session:test', senderIdentityId: 'agent:test', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: 'Here is the completed answer.',
    content: { cloudRequestMessageId: 'request:wire', deliveryState: 'complete', thinkingText: 'Preparing the answer' },
    status: 'complete', parentMessageId: 'request:local', sequenceNum: 3, createdAtMs: 1_001, updatedAtMs: 6_000,
    contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'wire:terminal', ...overrides };
}
function desktopEnrichedResponse(overrides: Partial<CanonicalSessionMessage> = {}) {
  return response({ id: 'cloud:progress', sequenceNum: 2, sourceEventId: 'wire:progress',
    content: { ...response().content as object, desktopEntryId: 'entry:reply' }, ...overrides });
}

test('completed cloud lifecycle copies keep the desktop entry alias and render one runtime reply', () => {
  const enriched = desktopEnrichedResponse();
  const terminal = response();
  const duplicates = selfAgentMirrorDuplicateIds([enriched, terminal], identities, 'human:test', true);
  assert.deepEqual([...duplicates], [terminal.id]);
  const canonical = [enriched, terminal].filter((row) => !duplicates.has(row.id))
    .map((row) => mapCanonicalMessage(row, identities, 'human:test')!);
  const runtime = { ...canonical[0], id: 'runtime:reply', entryId: 'entry:reply',
    turn: { ...canonical[0].turn!, startedAtMs: 1_000, completedAtMs: 6_000 } };
  const merged = mergeCanonicalHistoryIntoRuntime(canonical, [runtime]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].turn!.completedAtMs! - merged[0].turn!.startedAtMs!, 5_000);
  assert.equal(merged[0].turn!.assistantText, terminal.contentText);
  assert.equal(merged[0].turn!.thinkingText, 'Preparing the answer');
});

test('desktop-enriched copy wins even when its sequence is later', () => {
  const enriched = desktopEnrichedResponse({ sequenceNum: 4 });
  assert.deepEqual([...selfAgentMirrorDuplicateIds([response(), enriched], identities, 'human:test', true)], ['cloud:terminal']);
});

test('equal cloud answers for different requests or agents remain separate', () => {
  for (const next of [
    response({ content: { cloudRequestMessageId: 'request:other', deliveryState: 'complete' } }),
    response({ parentMessageId: 'request:other' }),
    response({ senderIdentityId: 'agent:other' }),
    response({ sessionId: 'session:other' }),
    response({ content: { deliveryState: 'complete' } }),
    response({ contentText: 'A different answer.' }),
  ]) {
    assert.equal(selfAgentMirrorDuplicateIds([desktopEnrichedResponse(), next], identities, 'human:test', true).size, 0);
  }
});

test('cloud-only sessions reconcile completed lifecycle copies without desktop metadata', () => {
  const earlier = response({ id: 'cloud:earlier', sequenceNum: 2, sourceEventId: 'wire:earlier' });
  assert.deepEqual([...selfAgentMirrorDuplicateIds([earlier, response()], identities, 'human:test', true)], ['cloud:terminal']);
});
