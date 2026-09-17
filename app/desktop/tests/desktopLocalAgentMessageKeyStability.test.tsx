import assert from 'node:assert/strict';
import test from 'node:test';

import { appendOptimisticOutboundMessage } from '../src/features/chat/messageActions/optimistic';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';
import { transcriptMessageRenderKey } from '../src/features/chat/transcriptRenderKeys';
import type { DesktopChatState, Message } from '../src/kordi-app/types';

function emptyDesktopChatState(sessionId: string): DesktopChatState {
  return {
    activeSessionId: sessionId,
    activeSession: {
      id: sessionId,
      title: 'New chat',
      subtitle: '',
      updatedAtLabel: '',
      updatedAtMs: 0,
      messageCount: 0,
      draft: false,
      messages: [],
    },
    sessions: [],
    projects: [],
  } as unknown as DesktopChatState;
}

// A desktop local-agent send has no shared id with its canonical twin at first:
// the optimistic desktop message only gets a durable id once the backend
// round-trip completes and the transcript is refreshed with a real `entryId`.
// Passing the canonical row's id through as `clientMessageId` from the first
// frame is what lets the transcript key stay the same across that refresh.
test('a locally sent message keeps one transcript render key across the optimistic -> completed-turn refresh', () => {
  const sessionId = 'local-agent-session';
  const canonicalMessageId = 'msg:ui:fixed-test-id';

  const optimisticState = appendOptimisticOutboundMessage(
    emptyDesktopChatState(sessionId),
    sessionId,
    'Hello there',
    'Hello there',
    [],
    '10:00',
    [],
    null,
    canonicalMessageId,
  );
  const optimisticSourceMessage = optimisticState.activeSession.messages.at(-1)!;
  assert.equal(optimisticSourceMessage.transcriptRenderId, canonicalMessageId,
    'the optimistic desktop message must carry the canonical id as its render identity');

  const [optimisticTranscriptMessage] = mapDesktopMessagesForTranscript(sessionId, [optimisticSourceMessage]);
  assert.equal(optimisticTranscriptMessage.clientMessageId, canonicalMessageId);
  const optimisticKey = transcriptMessageRenderKey(optimisticTranscriptMessage, 0);

  // The completed-turn refresh replaces the optimistic message with a fresh
  // one fetched from the backend: it has a real `entryId` and no
  // `transcriptRenderId` of its own, so its raw id would otherwise differ.
  const refreshedSourceMessage = {
    role: 'user' as const,
    sender: 'Me',
    text: 'Hello there',
    timeLabel: '10:00',
    timestampMs: optimisticSourceMessage.timestampMs,
    entryId: 'server-entry-42',
  };
  const [refreshedTranscriptMessage] = mapDesktopMessagesForTranscript(sessionId, [refreshedSourceMessage]);
  assert.notEqual(refreshedTranscriptMessage.id, optimisticTranscriptMessage.id,
    'the raw id is expected to change once a durable entryId exists');
  assert.equal(refreshedTranscriptMessage.clientMessageId, undefined,
    'a freshly fetched message has no client-side render identity yet');

  const canonicalMessage: Message = {
    id: canonicalMessageId,
    role: 'user',
    text: 'Hello there',
    time: '10:00',
    timestampMs: optimisticSourceMessage.timestampMs,
  };
  const [enrichedTranscriptMessage] = mergeCanonicalHistoryIntoRuntime(
    [canonicalMessage],
    [refreshedTranscriptMessage],
  );
  assert.equal(enrichedTranscriptMessage.clientMessageId, canonicalMessageId,
    'the merge must borrow the canonical row\'s durable id for the refreshed runtime message');

  const enrichedKey = transcriptMessageRenderKey(enrichedTranscriptMessage, 0);
  assert.equal(enrichedKey, optimisticKey,
    'the transcript React key must stay the same before and after the refresh, so the bubble does not remount');
});

test('an assistant turn does not gain a clientMessageId from its transcriptRenderId', () => {
  const sessionId = 'local-agent-session';
  const assistantSourceMessage = {
    role: 'assistant' as const,
    sender: 'Kordi',
    text: 'On it.',
    timeLabel: '10:00',
    timestampMs: 1000,
    transcriptRenderId: 'turn-123',
  };
  const [assistantTranscriptMessage] = mapDesktopMessagesForTranscript(sessionId, [assistantSourceMessage]);
  assert.equal(assistantTranscriptMessage.id, 'turn-123');
  assert.equal(assistantTranscriptMessage.clientMessageId, undefined,
    'assistant continuity already relies on `id` alone; the live turn card never sets clientMessageId either');
});
