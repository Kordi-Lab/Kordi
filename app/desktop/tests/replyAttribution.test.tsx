import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyAttribution, replyStatusText } from '../src/features/chat/replyAttribution';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

function turn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Done',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
    ...overrides,
  };
}

function humanRequest(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg:request',
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@AliceKordi review the copy and call out confusing parts.',
    time: '10:00',
    ...overrides,
  };
}

test('buildReplyAttribution adds generic reply count and source quote without responder names', () => {
  const messages: Message[] = [
    humanRequest(),
    {
      id: 'msg:alice-response',
      role: 'external-agent',
      sender: "Alice's Kordi",
      senderType: 'agent',
      text: '',
      time: '10:02',
      replyToMessageId: 'msg:request',
      turn: turn({ id: 'turn-alice', assistantText: 'The CTA wording is confusing.' }),
    },
    {
      id: 'msg:bob-processing',
      role: 'external-agent',
      sender: "Bob's Kordi",
      senderType: 'agent',
      text: '',
      time: '10:03',
      replyToMessageId: 'msg:request',
      turn: turn({
        id: 'turn-bob',
        status: 'processing',
        message: 'Processing…',
        assistantText: '',
        completed: false,
        succeeded: false,
      }),
    },
  ];

  const result = buildReplyAttribution(messages);
  const request = result.messages[0];
  const aliceResponse = result.messages[1];
  const bobProcessing = result.messages[2];

  assert.equal(request.replySummary?.replyCount, 1);
  assert.equal(request.replySummary?.pending, true);
  assert.equal(request.replySummary?.targetMessageId, 'msg:alice-response');
  assert.equal(replyStatusText(request.replySummary), '1 reply · replying…');
  assert.doesNotMatch(replyStatusText(request.replySummary), /Alice|Bob|Kordi/);

  assert.equal(aliceResponse.turn?.sourceMessage?.messageId, 'msg:request');
  assert.equal(aliceResponse.turn?.sourceMessage?.senderLabel, 'Me');
  assert.equal(aliceResponse.turn?.sourceMessage?.text, '@AliceKordi review the copy and call out confusing parts.');
  assert.equal(bobProcessing.turn?.sourceMessage?.messageId, 'msg:request');
});

test('buildReplyAttribution adds pending summary for live turns linked to a request', () => {
  const request = humanRequest({ id: 'msg:live-request', text: '@MyKordi summarize launch risks.' });
  const liveTurn = turn({
    id: 'turn-live',
    status: 'processing',
    message: 'Processing…',
    assistantText: '',
    completed: false,
    succeeded: false,
    replyToMessageId: 'msg:live-request',
  });

  const result = buildReplyAttribution([request], liveTurn);

  assert.equal(result.messages[0]?.replySummary?.replyCount, 0);
  assert.equal(result.messages[0]?.replySummary?.pending, true);
  assert.equal(replyStatusText(result.messages[0]?.replySummary ?? null), 'Replying…');
  assert.equal(result.liveTurn?.sourceMessage?.messageId, 'msg:live-request');
});
