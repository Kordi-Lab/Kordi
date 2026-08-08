import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import type { Conversation } from '../src/kordi-app/types';

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'draft:local-chat',
    canonicalSessionId: undefined,
    name: 'New session',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Draft',
    participants: ['Me', 'My Kordi'],
    messages: [],
    ...overrides,
  };
}

test('pending local self-agent selection does not fall back to Kordi Support', () => {
  const draft = conversation({});
  const support = conversation({
    id: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    name: 'Kordi Support',
    type: 'person',
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Person chat',
    participants: ['Me', 'Kordi Support'],
    supportTicketEnabled: true,
  });
  const pendingSessionId = 'session:self-agent:generated-before-read-model-hydration';

  const selected = activeConversationForSelection(
    pendingSessionId,
    [support],
    { isNativeShell: true, nativeChatPlaceholder: draft },
  );

  assert.equal(selected.id, pendingSessionId);
  assert.equal(selected.canonicalSessionId, pendingSessionId);
  assert.equal(selected.name, 'New session');
  assert.equal(selected.type, 'owned-agent');
  assert.equal(selected.supportTicketEnabled, undefined);
  assert.deepEqual(selected.messages, []);
});
