import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchMaterializedLocalChatTarget } from '../src/features/chat/messageActions/localAgentSessionTarget';
import type { DesktopChatState } from '../src/kordi-app/types';

function chatState(sessionId: string): DesktopChatState {
  return { activeSessionId: sessionId, activeSession: { id: sessionId } } as unknown as DesktopChatState;
}

test('a stored session materializes from one read', async () => {
  const opened: string[] = [];
  const state = await fetchMaterializedLocalChatTarget('stored', null, async (id) => chatState(id), async (id) => { opened.push(id); });
  assert.equal(state?.activeSessionId, 'stored');
  assert.deepEqual(opened, []);
});

test('a session this Mac never stored is opened before it is read again', async () => {
  // The runtime falls back to its newest stored session until the migrated one is opened.
  const opened = new Set<string>();
  const reads: string[] = [];
  const readState = async (id: string) => {
    reads.push(id);
    return chatState(opened.has(id) ? id : 'newest-local-session');
  };
  const state = await fetchMaterializedLocalChatTarget('migrated', null, readState, async (id) => { opened.add(id); });
  assert.equal(state?.activeSessionId, 'migrated');
  assert.deepEqual(reads, ['migrated', 'migrated']);
});

test('a session that cannot be opened never fails the send or returns another session', async () => {
  const fallback = await fetchMaterializedLocalChatTarget('missing', null, async () => chatState('other'), async () => undefined);
  assert.equal(fallback, null);
  const failed = await fetchMaterializedLocalChatTarget('missing', null, async () => chatState('other'), async () => {
    throw new Error('Session is unavailable');
  });
  assert.equal(failed, null);
});

test('the session already shown needs no read', async () => {
  let reads = 0;
  const state = await fetchMaterializedLocalChatTarget('shown', chatState('shown'), async (id) => { reads += 1; return chatState(id); });
  assert.equal(state, null);
  assert.equal(reads, 0);
});
