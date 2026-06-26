import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyAttribution, replyStatusText, shouldInferLatestHumanReplyTarget, shouldSuppressAgentReplyAttribution } from '../src/features/chat/replyAttribution';
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

test('buildReplyAttribution links explicit human quoted replies without agent inference', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:alice',
      role: 'person',
      sender: 'Alice',
      isOwnMessage: false,
      text: 'Original question',
    }),
    humanRequest({
      id: 'msg:me-reply',
      role: 'user',
      sender: 'Me',
      isOwnMessage: true,
      text: 'Yes',
      replyToMessageId: 'msg:alice',
    }),
  ];

  const result = buildReplyAttribution(messages);

  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[0]?.replySummary?.targetMessageId, 'msg:me-reply');
  assert.equal(result.messages[1]?.sourceMessage?.messageId, 'msg:alice');
  assert.equal(result.messages[1]?.sourceMessage?.senderLabel, 'Alice');
  assert.equal(result.messages[1]?.sourceMessage?.text, 'Original question');
});


test('buildReplyAttribution does not count forwarded human messages as replies', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:source',
      role: 'person',
      sender: '222',
      isOwnMessage: false,
      text: 'a test message',
      time: '13:57',
    }),
    humanRequest({
      id: 'msg:forwarded',
      role: 'user',
      sender: '11',
      isOwnMessage: true,
      text: 'a test message',
      time: '13:58',
      messageAction: {
        schemaVersion: 1,
        kind: 'forward',
        source: {
          sourceSessionId: 'session:one',
          sourceMessageId: 'msg:source',
          senderLabel: '222',
          textPreview: 'a test message',
          attachmentCount: 0,
          timeLabel: '13:57',
        },
      },
      sourceMessage: {
        messageId: 'msg:source',
        senderLabel: '222',
        text: 'a test message',
        attachmentCount: 0,
        time: '13:57',
      },
    }),
  ];

  const result = buildReplyAttribution(messages);

  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.messages[1]?.messageAction?.kind, 'forward');
  assert.equal(result.messages[1]?.sourceMessage?.messageId, 'msg:source');
  assert.equal(result.messages[1]?.replyToMessageId, undefined);
});

test('buildReplyAttribution deduplicates repeated no-provider replies for one request and agent', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:request',
      text: '@MyKordi hello',
    }),
    {
      id: 'msg:no-provider-1',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'No provider configured yet.',
      time: '10:01',
      replyToMessageId: 'msg:request',
      turn: turn({
        id: 'turn-no-provider-1',
        status: 'failed',
        message: 'Failed',
        assistantText: '',
        completed: true,
        succeeded: false,
        error: 'No provider configured yet.',
      }),
    },
    {
      id: 'msg:no-provider-2',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'No provider configured yet.',
      time: '10:01',
      replyToMessageId: 'msg:request',
      turn: turn({
        id: 'turn-no-provider-2',
        status: 'failed',
        message: 'Failed',
        assistantText: '',
        completed: true,
        succeeded: false,
        error: 'Unknown model: openai/gpt-5.4',
      }),
    },
  ];

  const result = buildReplyAttribution(messages);

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(replyStatusText(result.messages[0]?.replySummary), '1 reply');
  assert.equal(result.messages[1]?.id, 'msg:no-provider-1');
});

test('buildReplyAttribution still deduplicates no-provider replies when self-agent reply chrome is suppressed', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:no-provider-request',
      text: '@MyKordi hello',
    }),
    {
      id: 'msg:no-provider-a',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'No provider configured yet.',
      time: '10:01',
      replyToMessageId: 'msg:no-provider-request',
      turn: turn({
        id: 'turn-no-provider-a',
        status: 'failed',
        assistantText: '',
        completed: true,
        succeeded: false,
        error: 'No provider configured yet.',
      }),
    },
    {
      id: 'msg:no-provider-b',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'No provider configured yet.',
      time: '10:01',
      replyToMessageId: 'msg:no-provider-request',
      turn: turn({
        id: 'turn-no-provider-b',
        status: 'failed',
        assistantText: '',
        completed: true,
        succeeded: false,
        error: 'No provider configured yet.',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, {
    suppressAgentReplyAttribution: true,
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.messages[1]?.turn?.sourceMessage, undefined);
});

test('buildReplyAttribution suppresses reply chrome for self-agent chat replies when requested', () => {
  const source = {
    messageId: 'msg:self-request',
    senderLabel: 'Me',
    text: 'check again',
    attachmentCount: 0,
    time: '10:00',
  };
  const messages: Message[] = [
    humanRequest({
      id: 'msg:self-request',
      text: 'check again',
    }),
    {
      id: 'msg:self-agent-answer',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '10:01',
      replyToMessageId: 'msg:self-request',
      sourceMessage: source,
      turn: turn({
        id: 'turn-self-agent-answer',
        assistantText: 'Still no reply yet.',
        replyToMessageId: 'msg:self-request',
        sourceMessage: source,
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, {
    inferLatestHumanRequest: false,
    suppressAgentReplyAttribution: true,
  });

  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.messages[1]?.replySummary, undefined);
  assert.equal(result.messages[1]?.sourceMessage, undefined);
  assert.equal(result.messages[1]?.turn?.sourceMessage, undefined);
  assert.equal(result.messages[1]?.turn?.replyToMessageId, undefined);
});

test('shouldInferLatestHumanReplyTarget enables fallback linking for person, external-agent, and group chats', () => {
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'person', participantSpaceId: null, canonicalParticipantCount: 2 }), true);
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'external-agent', participantSpaceId: null, canonicalParticipantCount: 2 }), true);
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'owned-agent', participantSpaceId: 'space-1', canonicalParticipantCount: 4 }), true);
  assert.equal(shouldInferLatestHumanReplyTarget({ type: 'owned-agent', participantSpaceId: null, canonicalParticipantCount: 1 }), false);
});

test('shouldInferLatestHumanReplyTarget does not quote new private self-agent fork turns', () => {
  assert.equal(shouldInferLatestHumanReplyTarget({
    type: 'owned-agent',
    participantSpaceId: null,
    canonicalParticipantCount: 1,
    forkedFromSessionId: 'parent-self-session',
  }), false);
});

test('buildReplyAttribution suppresses source quote in direct external-agent support chats', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:support-request',
      text: 'hihi',
    }),
    {
      id: 'msg:support-response',
      role: 'external-agent',
      sender: 'Kordi Support',
      senderType: 'agent',
      text: '',
      time: '23:10',
      replyToMessageId: 'msg:support-request',
      turn: turn({
        id: 'turn-support-response',
        assistantText: 'Hi! How can I help?',
        replyToMessageId: 'msg:support-request',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, {
    suppressAgentReplyAttribution: shouldSuppressAgentReplyAttribution({
      id: 'bridge:cloud:acct_support_owner',
      type: 'external-agent',
      participantSpaceId: null,
      canonicalParticipantCount: 2,
    }),
  });

  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.messages[1]?.sourceMessage, undefined);
  assert.equal(result.messages[1]?.turn?.sourceMessage, undefined);
  assert.equal(result.messages[1]?.turn?.replyToMessageId, undefined);
});

test('shouldSuppressAgentReplyAttribution is scoped to direct self and external-agent conversations', () => {
  assert.equal(shouldSuppressAgentReplyAttribution({
    id: 'session:self-agent:1',
    type: 'owned-agent',
    participantSpaceId: null,
    canonicalParticipantCount: 1,
  }), true);
  assert.equal(shouldSuppressAgentReplyAttribution({
    id: 'session:group:1',
    type: 'owned-agent',
    participantSpaceId: 'space-1',
    canonicalParticipantCount: 4,
  }), false);
  assert.equal(shouldSuppressAgentReplyAttribution({
    id: 'session:self-agent-group-fork',
    type: 'owned-agent',
    participantSpaceId: null,
    canonicalParticipantCount: 1,
    forkedFromSessionId: 'session:group:1',
  }), false);
  assert.equal(shouldSuppressAgentReplyAttribution({
    id: 'session:external-agent:1',
    type: 'external-agent',
    participantSpaceId: null,
    canonicalParticipantCount: 2,
  }), true);
  assert.equal(shouldSuppressAgentReplyAttribution({
    id: 'session:external-agent-group-fork',
    type: 'external-agent',
    participantSpaceId: null,
    canonicalParticipantCount: 2,
    forkedFromSessionId: 'session:group:1',
  }), false);
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

test('buildReplyAttribution falls back to visible request when explicit reply target was hidden as duplicate', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:visible-ui-request',
      text: '@MyKordi how are yo',
    }),
    {
      id: 'msg:my-agent-response',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '00:14',
      replyToMessageId: 'msg:hidden-runtime-duplicate',
      turn: turn({
        id: 'turn-my-agent',
        assistantText: 'I’m doing well — here and ready to help.',
        replyToMessageId: 'msg:hidden-runtime-duplicate',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });

  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[1]?.replyToMessageId, 'msg:visible-ui-request');
  assert.equal(result.messages[1]?.turn?.sourceMessage?.messageId, 'msg:visible-ui-request');
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

test('buildReplyAttribution prefers a newer direct plain request over a stale @Kordi mention without broad fallback inference', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:old-kordi-request',
      text: '@Kordi why i cannot send the seconed message',
      time: '15:02',
    }),
    {
      id: 'msg:old-error-response',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '15:02',
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
      text: 'No you need show me the short what to ask',
      time: '15:27',
    }),
    {
      id: 'msg:new-response',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '15:27',
      turn: turn({ id: 'turn-new-response', assistantText: 'Ask me this:' }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: false });

  assert.equal(result.messages[2]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[3]?.turn?.sourceMessage?.messageId, 'msg:new-plain-request');
  assert.equal(result.messages[3]?.turn?.sourceMessage?.text, 'No you need show me the short what to ask');
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

test('buildReplyAttribution links direct live turns to matching prompt without broad fallback inference', () => {
  const request = humanRequest({ id: 'msg:direct-request', text: 'check the gym in kaust' });
  const liveTurn = turn({
    id: 'turn-direct-live',
    prompt: 'check the gym in kaust',
    status: 'starting',
    message: 'Working…',
    assistantText: '',
    completed: false,
    succeeded: false,
  });

  const result = buildReplyAttribution([request], liveTurn, { inferLatestHumanRequest: false });

  assert.equal(result.messages[0]?.replySummary?.replyCount, 0);
  assert.equal(result.messages[0]?.replySummary?.pending, true);
  assert.equal(result.liveTurn?.sourceMessage?.messageId, 'msg:direct-request');
  assert.equal(result.liveTurn?.sourceMessage?.text, 'check the gym in kaust');
});

test('buildReplyAttribution suppresses live turn reply chrome for self-agent chat when requested', () => {
  const request = humanRequest({
    id: 'msg:live-self-request',
    text: 'check again',
  });
  const liveTurn = turn({
    id: 'live-turn-self-agent',
    sessionId: 'session:self-agent',
    prompt: 'check again',
    status: 'thinking',
    message: 'Thinking…',
    assistantText: '',
    completed: false,
    succeeded: false,
  });

  const result = buildReplyAttribution([request], liveTurn, {
    inferLatestHumanRequest: false,
    suppressAgentReplyAttribution: true,
  });

  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.liveTurn?.sourceMessage, undefined);
  assert.equal(result.liveTurn?.replyToMessageId, undefined);
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
