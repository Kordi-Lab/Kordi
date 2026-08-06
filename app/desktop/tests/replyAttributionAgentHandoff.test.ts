import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

function turn(overrides: Partial<DesktopChatTurnSnapshot>): DesktopChatTurnSnapshot {
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

function humanRequest(id: string, text: string): Message {
  return {
    id,
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text,
    time: '11:17',
  };
}

test('agent handoff replies quote the preceding agent instead of a stale human request', () => {
  const messages: Message[] = [
    humanRequest('msg:stale-local-request', '@MyKordi also who is in our group'),
    humanRequest(
      'msg:current-human-request',
      '@CUFishAIsKordi ask my Kordi to ask Shenzhe Zhu’s Kordi to reply “third hop”',
    ),
    {
      id: 'msg:stable-cufish-agent-slot',
      role: 'external-agent',
      sender: "C UFishAI's Kordi",
      senderType: 'agent',
      text: '',
      time: '11:18',
      replyToMessageId: 'msg:current-human-request',
      turn: turn({
        id: 'turn:cufish',
        assistantText: '@ShuYangsKordi, please ask @ShenzheZhusKordi to reply “third hop”.',
        replyToMessageId: 'msg:current-human-request',
      }),
    },
    {
      id: 'msg:stable-shuyang-agent-slot',
      role: 'owned-agent',
      sender: "Shu Yang's Kordi",
      senderType: 'agent',
      text: '',
      time: '11:19',
      replyToMessageId: 'msg:cloud-agent:cufish-terminal',
      turn: turn({
        id: 'turn:shuyang',
        assistantText: 'I can’t ask another agent in this hop. @ShenzheZhu, please reply “third hop”.',
        replyToMessageId: 'msg:cloud-agent:cufish-terminal',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });
  const handoffResponse = result.messages[3]?.turn?.sourceMessage;

  assert.equal(handoffResponse?.messageId, 'msg:stable-cufish-agent-slot');
  assert.equal(handoffResponse?.senderLabel, "C UFishAI's Kordi");
  assert.equal(
    handoffResponse?.text,
    '@ShuYangsKordi, please ask @ShenzheZhusKordi to reply “third hop”.',
  );
  assert.notEqual(handoffResponse?.messageId, 'msg:stale-local-request');
});
