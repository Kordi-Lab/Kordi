import assert from 'node:assert/strict';
import test from 'node:test';

import { messageActionSourceFromMessage } from '../src/features/chat/messageActionMetadata';
import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import { KORDI_PIP_AVATAR_URL } from '../src/features/pip/pipIdentity';
import type { Message } from '../src/kordi-app/types/message';
import { turn } from './helpers/replyAttributionFixtures';

const base: Message = { id: 'msg:source', role: 'person', sender: 'Alice', senderType: 'human', text: 'Hello', time: '10:42' };

test('quotes and forwards of agent-written messages declare agent-turn', () => {
  const kind = (message: Message) => messageActionSourceFromMessage(message, 'session:group:g')?.sourceMessageKind;
  assert.equal(kind(base), 'text');
  assert.equal(kind({ ...base, role: 'owned-agent', senderType: 'agent' }), 'agent-turn');
  assert.equal(kind({ ...base, role: 'external-agent', senderType: 'agent' }), 'agent-turn');
  assert.equal(kind({ ...base, turn: turn({ assistantText: 'Done' }) }), 'agent-turn');
  // PiP posts as a service member; its messages are agent-written too.
  assert.equal(kind({ ...base, senderProfileImageUrl: KORDI_PIP_AVATAR_URL }), 'agent-turn');
});

function quoteOf(sourceMessageId: string, declaredKind: string, actionKind: 'quote' | 'forward' | 'thread' = 'quote'): Message {
  const source = {
    sourceSessionId: 'session:group:g', sourceMessageId, sourceMessageKind: declaredKind,
    senderLabel: 'Scout', textPreview: 'Saturday works', attachmentCount: 0,
  };
  return {
    id: 'msg:quote', role: 'person', sender: 'Bea', senderType: 'human', text: 'Agreed', time: '10:43',
    replyToMessageId: actionKind === 'quote' ? sourceMessageId : undefined,
    messageAction: { schemaVersion: 1, kind: actionKind, source },
    sourceMessage: { messageId: sourceMessageId, senderLabel: 'Scout', sourceMessageKind: declaredKind, text: 'Saturday works' },
  };
}

test('a quote uses the loaded source message before the declared kind', () => {
  const agentReply: Message = {
    id: 'msg:agent', role: 'external-agent', sender: 'Scout', senderType: 'agent', text: '', time: '10:41',
    turn: turn({ id: 'turn-agent', assistantText: 'Saturday works' }),
  };
  const human: Message = { ...base, id: 'msg:human', text: 'Saturday works' };
  // The quoting app said "text", but the loaded source is an agent reply.
  const [, quoted] = buildReplyAttribution([agentReply, quoteOf('msg:agent', 'text')]).messages;
  assert.equal(quoted?.sourceMessage?.sourceMessageKind, 'agent-turn');
  // The quoting app said "agent-turn", but the loaded source is a person.
  const [, quotedHuman] = buildReplyAttribution([human, quoteOf('msg:human', 'agent-turn')]).messages;
  assert.equal(quotedHuman?.sourceMessage?.sourceMessageKind, 'text');
  // Thread replies also prefer the loaded source.
  const [, threaded] = buildReplyAttribution([agentReply, quoteOf('msg:agent', 'text', 'thread')]).messages;
  assert.equal(threaded?.sourceMessage?.sourceMessageKind, 'agent-turn');
});

test('a quote whose source is not loaded keeps the declared kind, and forwards always do', () => {
  const [missing] = buildReplyAttribution([quoteOf('msg:elsewhere', 'agent-turn')]).messages;
  assert.equal(missing?.sourceMessage?.sourceMessageKind, 'agent-turn');
  const human: Message = { ...base, id: 'msg:human', text: 'Saturday works' };
  const [, forwarded] = buildReplyAttribution([human, quoteOf('msg:human', 'agent-turn', 'forward')]).messages;
  assert.equal(forwarded?.sourceMessage?.sourceMessageKind, 'agent-turn');
});
