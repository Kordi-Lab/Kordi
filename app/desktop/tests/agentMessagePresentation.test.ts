import test from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalIdentity, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { agentMessagePresentation } from '../src/features/canonical/readModel/agentMessagePresentation';
import { presentLocalAgentMessages } from '../src/features/canonical/readModel/localAgentPresentation';
import { buildDesktopLiveTurnTranscriptMessage } from '../src/features/chat/desktopLiveTurns';

function identity(overrides: Partial<CanonicalIdentity> & Pick<CanonicalIdentity, 'id' | 'kind' | 'displayName'>): CanonicalIdentity {
  return { source: 'cloud', avatarKey: overrides.id, createdAtMs: 1, updatedAtMs: 1, ...overrides };
}

const me = identity({ id: 'human:me', kind: 'human', displayName: 'Main Test A', humanId: 'acct-me' });
const myAgent = identity({
  id: 'agent:me', kind: 'agent', displayName: 'Kordi', ownerIdentityId: me.id, humanId: 'acct-me', agentId: 'cloud-agent:acct-me',
});
const peer = identity({ id: 'human:peer', kind: 'human', displayName: 'Main Test B', humanId: 'acct-peer' });
const peerAgent = identity({
  id: 'agent:peer', kind: 'agent', displayName: 'Kordi', ownerIdentityId: peer.id, humanId: 'acct-peer', agentId: 'cloud-agent:acct-peer',
});
const identityById = new Map([me, myAgent, peer, peerAgent].map((entry) => [entry.id, entry]));

test('own agent owner label stays "You" even when the message stores an owner name', () => {
  const stored = agentMessagePresentation(myAgent, identityById, me.id, 'Kordi', 'Main Test A', true);
  const unstored = agentMessagePresentation(myAgent, identityById, me.id, 'Kordi', undefined, true);
  assert.equal(stored.senderOwnerName, 'You');
  assert.equal(unstored.senderOwnerName, 'You');
  assert.equal(stored.sender, unstored.sender);
  assert.equal(stored.sender, 'Kordi');
});

test('own agent persisted row matches the live turn row after local presentation', () => {
  const localAgentDisplayName = "Main Test A's Kordi";
  const persisted = agentMessagePresentation(myAgent, identityById, me.id, 'Kordi', 'Main Test A', true);
  const [presented] = presentLocalAgentMessages([{
    role: 'owned-agent', sender: persisted.sender, senderOwnerName: persisted.senderOwnerName, text: 'done', time: '12:00',
  } satisfies Message], localAgentDisplayName);
  const live = buildDesktopLiveTurnTranscriptMessage({
    id: 'turn-1', sessionId: 's', prompt: 'hi', status: 'running', message: '', assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false,
  } satisfies DesktopChatTurnSnapshot, localAgentDisplayName);
  assert.equal(presented.sender, live.sender);
  assert.equal(presented.senderOwnerName, live.senderOwnerName);
});

test("another user's agent keeps the owner's display name", () => {
  const stored = agentMessagePresentation(peerAgent, identityById, me.id, 'Kordi', 'Main Test B', true);
  const unstored = agentMessagePresentation(peerAgent, identityById, me.id, 'Kordi', undefined, true);
  assert.equal(stored.senderOwnerName, 'Main Test B');
  assert.equal(unstored.senderOwnerName, 'Main Test B');
  assert.equal(stored.sender, "Main Test B's Kordi");
  assert.equal(unstored.sender, "Main Test B's Kordi");
});
