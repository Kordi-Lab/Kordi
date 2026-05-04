import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentMentionQuery, filterMentionTargets, removeSessionFromCanonicalState } from '../src/app/useKordiAppModelHelpers';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('mention helper hides suggestions after an exact mention followed by whitespace', () => {
  const query = currentMentionQuery('@Kordi ');
  const options = [{
    value: 'Kordi',
    label: 'Kordi',
    detail: 'Local agent',
    nodeId: 'agent-local',
    runtime: 'local',
  }];

  assert.deepEqual(filterMentionTargets(options, query), []);
});

test('canonical session removal prunes session-scoped records', () => {
  const state = {
    sessions: [{ id: 'keep' }, { id: 'drop' }],
    participants: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    messages: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    delegatedExchanges: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    presence: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
    contextSnapshots: [{ sessionId: 'drop' }, { sessionId: 'keep' }],
  } as CanonicalSessionState;

  const next = removeSessionFromCanonicalState(state, 'drop')!;

  assert.deepEqual(next.sessions.map((session) => session.id), ['keep']);
  assert.deepEqual(next.messages.map((message) => message.sessionId), ['keep']);
  assert.deepEqual(next.participants.map((participant) => participant.sessionId), ['keep']);
});
