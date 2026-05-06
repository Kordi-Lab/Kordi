import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyAttribution, replyStatusText, shouldInferLatestHumanReplyTarget } from '../src/features/chat/replyAttribution';
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

test('shouldInferLatestHumanReplyTarget enables fallback linking for person, external-agent, and group chats', () => {
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'person', participantSpaceId: null, canonicalParticipantCount: 2 }), true);
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'external-agent', participantSpaceId: null, canonicalParticipantCount: 2 }), true);
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'owned-agent', participantSpaceId: 'space-1', canonicalParticipantCount: 4 }), true);
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'owned-agent', participantSpaceId: null, canonicalParticipantCount: 1 }), false);
});

test('buildReplyAttribution resolves canonical bridge parent aliases as the source request', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:canonical-jiaxin-request',
      role: 'person',
      sender: 'Jiaxin',
      isOwnMessage: false,
      text: '@ShuyheresKordi add a github issue on not popping up new message count information pop-up.',
      replyAliasIds: ['msg:ui:jiaxin-request', 'bridge_req_jiaxin'],
    }),
    {
      id: 'msg:canonical-my-agent-response',
      role: 'owned-agent',
      sender: "Shuyhere's Kordi",
      senderType: 'agent',
      text: '',
      time: '10:05',
      replyToMessageId: 'msg:ui:jiaxin-request',
      turn: turn({
        id: 'turn-jiaxin-response',
        assistantText: 'Done — filed as issue #214.',
        replyToMessageId: 'msg:ui:jiaxin-request',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });

  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(replyStatusText(result.messages[0]?.replySummary), '1 reply');
  assert.equal(result.messages[1]?.turn?.sourceMessage?.messageId, 'msg:canonical-jiaxin-request');
  assert.equal(result.messages[1]?.turn?.sourceMessage?.senderLabel, 'Jiaxin');
});

test('buildReplyAttribution can infer other peoples requests as source when explicit reply ids are missing', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:peer-request',
      role: 'person',
      sender: 'Shenzhe Zhu',
      isOwnMessage: false,
      text: '@ShuyheresKordi please file this issue from the template.',
    }),
    {
      id: 'msg:my-agent-response',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '10:04',
      turn: turn({ id: 'turn-my-agent', assistantText: 'Done — filed the issue.' }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });

  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(replyStatusText(result.messages[0]?.replySummary), '1 reply');
  assert.equal(result.messages[1]?.turn?.sourceMessage?.messageId, 'msg:peer-request');
  assert.equal(result.messages[1]?.turn?.sourceMessage?.senderLabel, 'Shenzhe Zhu');
});

test('buildReplyAttribution prefers a newer own plain request over a stale @Kordi mention', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:old-kordi-request',
      text: '@Kordi why i cannot send the second message',
      time: '12:54',
    }),
    {
      id: 'msg:old-error-response',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '12:54',
      turn: turn({
        id: 'turn-old-error',
        assistantText: '',
        message: 'Provider error: overloaded',
        status: 'failed',
        succeeded: false,
        error: 'Provider error: overloaded',
      }),
    },
    humanRequest({
      id: 'msg:new-plain-request',
      text: 'Create a markdown form to preview',
      time: '13:34',
    }),
    {
      id: 'msg:new-response',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '13:34',
      turn: turn({ id: 'turn-new-response', assistantText: 'Considering markdown formatting options.' }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });

  assert.equal(result.messages[2]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[3]?.turn?.sourceMessage?.messageId, 'msg:new-plain-request');
  assert.equal(result.messages[3]?.turn?.sourceMessage?.text, 'Create a markdown form to preview');
  assert.equal(result.messages[0]?.replySummary?.targetMessageId, 'msg:old-error-response');
});

test('buildReplyAttribution prefers the latest matching @mention over later non-request chat', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:my-kordi-request',
      sender: 'Shuyhere',
      text: '@MyKordi fully debug and create this issue for fix',
    }),
    humanRequest({
      id: 'msg:peer-comment',
      role: 'person',
      sender: 'Shenzhe Zhu',
      isOwnMessage: false,
      text: 'I have already create the issue',
    }),
    humanRequest({
      id: 'msg:peer-xs',
      role: 'person',
      sender: 'Shenzhe Zhu',
      isOwnMessage: false,
      text: 'xs',
    }),
    {
      id: 'msg:my-kordi-response',
      role: 'owned-agent',
      sender: 'Kordi',
      senderType: 'agent',
      text: '',
      time: '10:06',
      turn: turn({ id: 'turn-my-kordi', assistantText: 'Using systematic-debugging to investigate.' }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });

  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[2]?.replySummary, undefined);
  assert.equal(result.messages[3]?.turn?.sourceMessage?.messageId, 'msg:my-kordi-request');
  assert.equal(result.messages[3]?.turn?.sourceMessage?.text, '@MyKordi fully debug and create this issue for fix');
});

test('buildReplyAttribution keeps pending live turn on agent request before later person mention', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:my-kordi-request',
      text: '@MyKordi can you check the related popular work for me',
    }),
    humanRequest({
      id: 'msg:person-mention',
      text: '@Testuser6 also you need find the popular github repo',
      mentions: [{ label: 'Testuser6', targetKind: 'bridge-person' }],
    }),
  ];
  const liveTurn = turn({
    id: 'turn-my-kordi',
    prompt: '@Kordi can you check the related popular work for me',
    status: 'processing',
    message: 'Processing…',
    assistantText: '',
    completed: false,
    succeeded: false,
  });

  const result = buildReplyAttribution(messages, liveTurn, { inferLatestHumanRequest: true });

  assert.equal(replyStatusText(result.messages[0]?.replySummary ?? null), 'Replying…');
  assert.equal(result.messages[1]?.replySummary, undefined);
  assert.equal(result.liveTurn?.sourceMessage?.messageId, 'msg:my-kordi-request');
});

test('buildReplyAttribution scopes inferred replies to each mentioned agent request', () => {
  const messages: Message[] = [
    humanRequest({ id: 'msg:alice-request', text: '@AliceKordi review the memory model.' }),
    humanRequest({ id: 'msg:bob-request', text: '@BobKordi find related repos.' }),
    {
      id: 'msg:alice-response',
      role: 'external-agent',
      sender: 'AliceKordi',
      senderType: 'agent',
      text: '',
      time: '10:05',
      turn: turn({ id: 'turn-alice', assistantText: 'Memory model notes.' }),
    },
    {
      id: 'msg:bob-response',
      role: 'external-agent',
      sender: 'BobKordi',
      senderType: 'agent',
      text: '',
      time: '10:06',
      turn: turn({ id: 'turn-bob', assistantText: 'Related repo notes.' }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });

  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[1]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[2]?.turn?.sourceMessage?.messageId, 'msg:alice-request');
  assert.equal(result.messages[3]?.turn?.sourceMessage?.messageId, 'msg:bob-request');
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
