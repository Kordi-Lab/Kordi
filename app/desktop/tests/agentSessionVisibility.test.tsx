import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildParticipantSpaces,
  ensureSelfParticipantSpace,
  filterParticipantSpaces,
} from '../src/features/chat/participantSpaces';
import type { Conversation } from '../src/kordi-app/types';

function agentConversation(
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id: 'session:agent-placeholder',
    canonicalSessionId: 'session:agent-placeholder',
    name: 'New chat',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Draft',
    participants: ['Me', 'My Kordi'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'agent:my-kordi', name: 'My Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'agent' },
    ],
    messages: [{ role: 'system', text: 'Draft session', time: 'Draft' }],
    ...overrides,
  };
}

test('filterParticipantSpaces hides unmaterialized agent shells from the Agent channel', () => {
  const spaces = ensureSelfParticipantSpace(buildParticipantSpaces([
    agentConversation(),
  ]));

  assert.deepEqual(
    filterParticipantSpaces(spaces, '', 'agent').flatMap((space) => space.sessions),
    [],
  );
});

test('filterParticipantSpaces keeps agent sessions after their first user-visible message', () => {
  const spaces = buildParticipantSpaces([
    agentConversation({
      id: 'session:agent-ready',
      canonicalSessionId: 'session:agent-ready',
      subtitle: 'Plan the release',
      messages: [{ role: 'person', sender: 'Me', text: 'Plan the release', time: '10:00' }],
    }),
  ]);

  assert.deepEqual(
    filterParticipantSpaces(spaces, '', 'agent').flatMap(
      (space) => space.sessions.map((session) => session.id),
    ),
    ['session:agent-ready'],
  );
});
