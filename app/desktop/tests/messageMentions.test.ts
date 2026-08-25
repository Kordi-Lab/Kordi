import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mentionForCollaborationTarget,
  mentionsForAllGroupMembers,
  mentionsForConversationParticipants,
  normalizedMessageMentions,
} from '../src/features/chat/messageMentions';
import type { Conversation } from '../src/kordi-app/types';

test('group participant mentions keep stable human identities and exact multi-word ranges', () => {
  const group = {
    canonicalParticipants: [
      { id: 'human:alex', name: 'Alex Smith', kind: 'human', role: 'person', humanId: 'acct_alex', sourceIdentityId: 'node-alex-person' },
      { id: 'human:lian', name: 'Lian Compass', kind: 'human', role: 'person', humanId: 'acct_lian', sourceIdentityId: 'node-lian-person' },
    ],
  } as Conversation;
  const text = '(@AlexSmith), ask @Lian Compass to review.';
  const mentions = mentionsForConversationParticipants(text, group);

  assert.deepEqual(mentions.map((mention) => ({
    displayText: mention.displayText,
    targetIdentityId: mention.targetIdentityId,
    startUtf16: mention.startUtf16,
    lengthUtf16: mention.lengthUtf16,
  })), [{
    displayText: '@AlexSmith',
    targetIdentityId: 'human:acct_alex',
    startUtf16: text.indexOf('@AlexSmith'),
    lengthUtf16: '@AlexSmith'.length,
  }, {
    displayText: '@Lian Compass',
    targetIdentityId: 'human:acct_lian',
    startUtf16: text.indexOf('@Lian Compass'),
    lengthUtf16: '@Lian Compass'.length,
  }]);
});

test('collaboration mention metadata preserves every occurrence of one agent', () => {
  const text = "@Alice's Kordi ask @AlicesKordi to compare notes.";
  const mentions = mentionForCollaborationTarget({
    host: { id: 'cloud' } as never,
    peer: { nodeId: 'acct_alice', agentId: 'cloud_agent_alice' } as never,
    label: 'AlicesKordi',
    displayLabel: "Alice's Kordi",
    targetKind: 'agent',
    requestText: 'compare notes',
  }, text);

  assert.deepEqual(mentions.map((mention) => mention.displayText), ["@Alice's Kordi", '@AlicesKordi']);
  assert.deepEqual(mentions.map((mention) => mention.startUtf16), [0, text.indexOf('@AlicesKordi')]);
  assert.ok(mentions.every((mention) => mention.targetIdentityId === 'agent:cloud_agent_alice'));
});

test('group @all mentions use one scoped entity and reject plain or invalid scopes', () => {
  const group = {
    id: 'session:group:triad',
    canonicalSessionId: 'session:group:triad',
    directness: 'Group chat',
  } as Conversation;
  const text = 'Email me@all.example, then @all and @ALL.';
  const mentions = mentionsForAllGroupMembers(text, group);

  assert.deepEqual(mentions.map((mention) => ({
    displayText: mention.displayText,
    targetKind: mention.targetKind,
    targetIdentityId: mention.targetIdentityId,
  })), [{
    displayText: '@all',
    targetKind: 'all',
    targetIdentityId: 'group:session:group:triad',
  }, {
    displayText: '@ALL',
    targetKind: 'all',
    targetIdentityId: 'group:session:group:triad',
  }]);
  assert.deepEqual(mentionsForAllGroupMembers('@all', { id: 'direct', directness: 'Direct chat' }), []);
  assert.equal(normalizedMessageMentions([{
    ...mentions[0],
    targetIdentityId: 'human:acct_me',
  }]), undefined);
  assert.equal(normalizedMessageMentions([{
    label: 'all',
    targetKind: 'all',
    targetIdentityId: 'group:session:group:triad',
  }]), undefined);
});
