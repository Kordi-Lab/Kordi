import { strict as assert } from 'node:assert';
import test from 'node:test';

import { commitDesktopSessionSelectionAfterTranscriptReady } from '../src/features/chat/desktopSessionSelection';

test('uncached desktop session selection waits for authoritative transcript preload', async () => {
  const events: string[] = [];

  const committed = await commitDesktopSessionSelectionAfterTranscriptReady({
    sessionId: 'session-1',
    isTranscriptCached: () => false,
    preloadTranscript: async (sessionId) => {
      events.push(`preload:${sessionId}`);
      return true;
    },
    isSelectionCurrent: () => true,
    selectSession: (sessionId) => events.push(`select:${sessionId}`),
  });

  assert.equal(committed, true);
  assert.deepEqual(events, ['preload:session-1', 'select:session-1']);
});

test('cached desktop session selection commits without another preload', async () => {
  const events: string[] = [];

  const committed = await commitDesktopSessionSelectionAfterTranscriptReady({
    sessionId: 'session-1',
    isTranscriptCached: () => true,
    preloadTranscript: async () => {
      events.push('unexpected-preload');
      return true;
    },
    isSelectionCurrent: () => true,
    selectSession: (sessionId) => events.push(`select:${sessionId}`),
  });

  assert.equal(committed, true);
  assert.deepEqual(events, ['select:session-1']);
});

test('stale desktop session selection cannot replace a newer click', async () => {
  const events: string[] = [];

  const committed = await commitDesktopSessionSelectionAfterTranscriptReady({
    sessionId: 'session-1',
    isTranscriptCached: () => false,
    preloadTranscript: async () => {
      events.push('preload');
      return true;
    },
    isSelectionCurrent: () => false,
    selectSession: () => events.push('unexpected-select'),
  });

  assert.equal(committed, false);
  assert.deepEqual(events, ['preload']);
});

test('failed preload still commits the requested session for refresh error recovery', async () => {
  const events: string[] = [];

  const committed = await commitDesktopSessionSelectionAfterTranscriptReady({
    sessionId: 'session-1',
    isTranscriptCached: () => false,
    preloadTranscript: async () => {
      events.push('preload');
      throw new Error('unavailable');
    },
    isSelectionCurrent: () => true,
    selectSession: (sessionId) => events.push(`select:${sessionId}`),
  });

  assert.equal(committed, true);
  assert.deepEqual(events, ['preload', 'select:session-1']);
});
