import assert from 'node:assert/strict';
import test from 'node:test';

import { newMessageAttentionEvents } from '../src/features/notifications/messageAttentionPolicy';
import { KORDI_PIP_AVATAR_URL, KORDI_PIP_TAG } from '../src/features/pip/pipIdentity';
import type { Conversation, Message } from '../src/kordi-app/types';
import { turn } from './helpers/replyAttributionFixtures';

function conversation(message: Message): Conversation {
  return {
    id: 'group-1', canonicalSessionId: 'session:group:g', name: 'Weekend', type: 'person', subtitle: '', unread: 1,
    collaborationSources: [], trust: '', directness: '', participants: [], messages: [message],
  };
}

function titleFor(message: Message) {
  return newMessageAttentionEvents({ previous: {}, conversations: [conversation(message)] })[0]?.title;
}

test('notification titles mark agent and PiP messages as AI', () => {
  assert.equal(titleFor({ id: 'h', role: 'person', sender: 'Bea', text: 'Hi', time: '' }), 'Bea');
  assert.equal(titleFor({ id: 'a', role: 'external-agent', sender: 'Scout', text: '', time: '', turn: turn({ assistantText: 'Hi' }) }), 'Scout (AI)');
  assert.equal(titleFor({ id: 'o', role: 'owned-agent', sender: 'Kordi', text: 'Done', time: '' }), 'Kordi (AI)');
  assert.equal(titleFor({ id: 'p', role: 'person', sender: 'PiP', senderProfileImageUrl: KORDI_PIP_AVATAR_URL, text: 'Plan updated', time: '' }), 'PiP (AI)');
  // Without a sender name the conversation name stands in, still marked.
  assert.equal(titleFor({ id: 'n', role: 'external-agent', text: 'Hi', time: '' }), 'Weekend (AI)');
});

test('PiP is introduced as a built-in AI agent', () => {
  assert.equal(KORDI_PIP_TAG, 'Built-in AI agent');
});
