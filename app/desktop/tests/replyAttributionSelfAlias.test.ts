import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import type { Message } from '../src/kordi-app/types';
import { humanRequest, turn } from './helpers/replyAttributionFixtures';

function response(overrides: Partial<Message> = {}): Message {
  return {
    id: 'response',
    role: 'owned-agent',
    sender: 'Agent',
    senderType: 'agent',
    text: '',
    time: '10:01',
    replyToMessageId: 'request',
    replyAliasIds: ['request', 'terminal-response'],
    turn: turn({ assistantText: 'Started the task.', replyToMessageId: 'request' }),
    ...overrides,
  };
}

test('an unloaded request alias never makes an agent quote itself or a sibling reply', () => {
  const result = buildReplyAttribution([
    response(),
    response({ id: 'other-response' }),
  ]);
  for (const message of result.messages) {
    assert.equal(message.replyToMessageId, 'request');
    assert.equal(message.sourceMessage, undefined);
    assert.equal(message.turn?.sourceMessage, undefined);
    assert.equal(message.replySummary, undefined);
  }
});

test('the real request wins after hydration even when it follows its response in the input', () => {
  const request = humanRequest({ id: 'request', text: 'Run the task.' });
  const result = buildReplyAttribution([response(), request]);
  assert.equal(result.messages[0].sourceMessage?.messageId, 'request');
  assert.equal(result.messages[0].sourceMessage?.text, request.text);
  assert.equal(result.messages[1].replySummary?.replyCount, 1);
});

test('unloaded and deleted request previews survive without using response aliases', () => {
  for (const text of ['Original request.', 'Message deleted.']) {
    const source = { messageId: 'request', senderLabel: 'User', text };
    const result = buildReplyAttribution([response({
      sourceMessage: source,
      turn: turn({ replyToMessageId: 'request', sourceMessage: source }),
    })]);
    assert.deepEqual(result.messages[0].sourceMessage, source);
    assert.deepEqual(result.messages[0].turn?.sourceMessage, source);
  }
});

test('a malformed explicit self-reference is not rendered as a quote', () => {
  const selfSource = { messageId: 'response', text: 'Started the task.' };
  const result = buildReplyAttribution([response({
    replyToMessageId: 'response',
    sourceMessage: selfSource,
    turn: turn({ replyToMessageId: 'response', sourceMessage: selfSource }),
  })]);
  assert.equal(result.messages[0].sourceMessage, undefined);
  assert.equal(result.messages[0].turn?.sourceMessage, undefined);
  assert.equal(result.messages[0].replySummary, undefined);
});

test('agent handoffs still resolve the preceding response by its terminal alias', () => {
  const result = buildReplyAttribution([
    response(),
    response({
      id: 'handoff',
      replyToMessageId: 'terminal-response',
      replyAliasIds: ['terminal-response'],
      turn: turn({ replyToMessageId: 'terminal-response' }),
    }),
  ]);
  assert.equal(result.messages[1].sourceMessage?.messageId, 'response');
  assert.equal(result.messages[1].sourceMessage?.text, 'Started the task.');
  assert.equal(result.messages[0].replySummary?.replyCount, 1);
});
