import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import { nativeChatPlaceholderForSelection } from '../src/app/viewModels/nativeChatSelection';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { joinPersonalAgents } from '../src/features/personalAgent/personalAgentEntries';
import { setPersonalAgentEntries } from '../src/features/personalAgent/personalAgentStore';
import type { Agent, Conversation } from '../src/kordi-app/types';

const ACCOUNT = 'acct_alex';
const DEFAULT_ID = `cloud-agent:${ACCOUNT}`;
const PERSONAL_SESSION = `session:self-agent:${ACCOUNT}:personal:${DEFAULT_ID}`;
const PLAIN_SESSION = 'session:self-agent:plain-empty';

function canonicalState() {
  const session = (id: string, metadata: Record<string, unknown>, atMs: number) => ({
    id, kind: 'self-agent', title: "Alex's Kordi", status: 'active', createdByIdentityId: 'human:me',
    primaryIdentityId: 'agent:local', relationshipIdentityId: null, metadata, createdAtMs: atMs, updatedAtMs: atMs, lastMessageAtMs: null,
  });
  return {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', displayName: 'Alex', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:local', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Alex', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: "Alex's Kordi", ownerIdentityId: 'human:me', source: 'local', avatarKey: 'kordi', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      session(PERSONAL_SESSION, { cloudSelfAgentSession: true, personalAgent: { agentId: DEFAULT_ID } }, 2),
      session(PLAIN_SESSION, {}, 1),
    ],
    participants: [PERSONAL_SESSION, PLAIN_SESSION].flatMap((sessionId) => [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ]),
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

function groupConversation(): Conversation {
  return {
    id: 'session:group:weekend', canonicalSessionId: 'session:group:weekend', name: 'weekend', type: 'owned-agent', subtitle: '',
    unread: 0, collaborationSources: ['Cloud'], trust: 'Cloud', directness: 'Group chat', participants: ['Me', 'Sam'],
    messages: [{ id: 'm1', role: 'person', sender: 'Sam', senderType: 'human', text: 'hi', time: '10:00' }],
  };
}

test('an empty personal session of the default agent stays in the chat list; a plain empty one does not', () => {
  const readModel = createCanonicalSessionReadModel(canonicalState() as never);
  const conversations = readModel?.buildChatConversations([], (_messages, fallback) => fallback ?? '') ?? [];
  const ids = conversations.map((conversation) => conversation.canonicalSessionId ?? conversation.id);

  assert.ok(ids.includes(PERSONAL_SESSION), 'the personal row must have a conversation to select');
  assert.ok(!ids.includes(PLAIN_SESSION));
});

test('selecting the personal row opens its own session, never the first other chat', () => {
  const readModel = createCanonicalSessionReadModel(canonicalState() as never);
  const personal = (readModel?.buildChatConversations([], (_messages, fallback) => fallback ?? '') ?? [])
    .find((conversation) => (conversation.canonicalSessionId ?? conversation.id) === PERSONAL_SESSION)!;
  const group = groupConversation();
  const options = { isNativeShell: true, nativeChatPlaceholder: nativeChatPlaceholderForSelection(PERSONAL_SESSION), fallbackConversation: group };

  const selected = activeConversationForSelection(PERSONAL_SESSION, [group, personal], options);
  assert.equal(selected.canonicalSessionId ?? selected.id, PERSONAL_SESSION);
});

test('a listed personal session this Mac does not have yet shows the empty pane, not another chat', () => {
  const kordi = { id: 'desktop:local-agent', name: "Alex's Kordi", isOwned: true, contactId: 'desktop:local-agent' } as unknown as Agent;
  setPersonalAgentEntries(joinPersonalAgents([
    { agentId: DEFAULT_ID, conversationId: 'conv-kordi', sessionId: PERSONAL_SESSION, proactive: true },
  ], [kordi], ACCOUNT), true);
  try {
    const group = groupConversation();
    const placeholder = nativeChatPlaceholderForSelection(PERSONAL_SESSION);
    const options = { isNativeShell: true, nativeChatPlaceholder: placeholder, fallbackConversation: group };

    assert.equal(activeConversationForSelection(PERSONAL_SESSION, [group], options), placeholder);
    // An unknown id still falls back as before.
    assert.equal(activeConversationForSelection('session:self-agent:gone', [group], options), group);
  } finally {
    setPersonalAgentEntries([], false);
  }
});
