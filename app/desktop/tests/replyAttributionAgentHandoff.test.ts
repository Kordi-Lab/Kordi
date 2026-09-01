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

test('a terminal agent reply suppresses a stale pending projection for the same request', () => {
  const request = humanRequest('msg:request', '@Kordirename11 which model are you using?');
  const completed: Message = {
    id: 'msg:complete', role: 'owned-agent', sender: 'Kordirename11', senderType: 'agent', text: '', time: '20:28', replyToMessageId: request.id,
    turn: turn({ id: 'turn:complete', assistantText: 'I am an OpenAI model.', replyToMessageId: request.id }),
  };
  const stalePending: Message = {
    id: 'msg:pending', role: 'owned-agent', sender: 'Kordirename11', senderType: 'agent', text: '', time: '20:28', replyToMessageId: request.id,
    turn: turn({ id: 'turn:pending', status: 'processing', message: 'Processing…', assistantText: '', completed: false, succeeded: false, replyToMessageId: request.id }),
  };

  const result = buildReplyAttribution([request, completed, stalePending]);
  assert.deepEqual(result.messages.map((message) => message.id), ['msg:request', 'msg:complete']);
  assert.equal(result.messages[0]?.replySummary?.replyCount, 1);
  assert.equal(result.messages[0]?.replySummary?.pending, false);
});
