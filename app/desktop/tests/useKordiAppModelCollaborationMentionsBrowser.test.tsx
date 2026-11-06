import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollaborationMentionTargetsByScope } from '../src/app/useKordiAppModelCollaborationMentions';
import type { Conversation } from '../src/kordi-app/types';

test('buildCollaborationMentionTargetsByScope lists group people without desktop collaboration state', () => {
  // The browser app has no local Bridge state; group members still come from the conversation.
  const group = {
    id: 'session:group:web',
    canonicalSessionId: 'session:group:web',
    name: 'Web group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Group chat',
    participantSpaceId: 'group:web',
    participants: ['Me', 'Alice'],
    canonicalParticipants: [
      { id: 'human:acct_me', name: 'Me', kind: 'human', role: 'self', source: 'local', humanId: 'acct_me', sourceIdentityId: 'acct_me' },
      { id: 'human:acct_alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_alice', sourceIdentityId: 'acct_alice' },
    ],
    messages: [],
  } as Conversation;

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: null,
    desktopChatState: null,
    activeConvMentionScope: group,
  });

  assert.deepEqual(
    targets.chat.map((target) => `${target.targetKind}:${target.label}`),
    ['all:All', 'person:Alice'],
  );
});
