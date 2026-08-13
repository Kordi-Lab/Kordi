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
      '@ResearchAgentsKordi ask my Kordi to ask Ethan Park’s Kordi to reply “third hop”',
    ),
    {
      id: 'msg:stable-research-agent-slot',
      role: 'external-agent',
      sender: "Research Agent's Kordi",
      senderType: 'agent',
      text: '',
      time: '11:18',
      replyToMessageId: 'msg:current-human-request',
      turn: turn({
        id: 'turn:research-agent',
        assistantText: '@AlexMorgansKordi, please ask @EthanParksKordi to reply “third hop”.',
        replyToMessageId: 'msg:current-human-request',
      }),
    },
    {
      id: 'msg:stable-alex-agent-slot',
      role: 'owned-agent',
      sender: "Alex Morgan's Kordi",
      senderType: 'agent',
      text: '',
      time: '11:19',
      replyToMessageId: 'msg:cloud-agent:research-agent-terminal',
      turn: turn({
        id: 'turn:alex',
        assistantText: 'I can’t ask another agent in this hop. @EthanPark, please reply “third hop”.',
        replyToMessageId: 'msg:cloud-agent:research-agent-terminal',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, { inferLatestHumanRequest: true });
  const handoffResponse = result.messages[3]?.turn?.sourceMessage;

  assert.equal(handoffResponse?.messageId, 'msg:stable-research-agent-slot');
  assert.equal(handoffResponse?.senderLabel, "Research Agent's Kordi");
  assert.equal(
    handoffResponse?.text,
    '@AlexMorgansKordi, please ask @EthanParksKordi to reply “third hop”.',
  );
  assert.notEqual(handoffResponse?.messageId, 'msg:stale-local-request');
});
