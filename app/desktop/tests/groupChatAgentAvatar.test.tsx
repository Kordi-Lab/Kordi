import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { setMessageLayout, type MessageLayout } from '../src/app/messageLayoutPreference';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { MessageBubble, type TranscriptDensityMode } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const turn: DesktopChatTurnSnapshot = {
  id: 'peer-turn', sessionId: 'session:group:team', prompt: '', status: 'complete', message: 'Complete',
  assistantText: 'Turn reply', thinkingText: '', tools: [], completed: true, succeeded: true, error: null,
};
const peerAgentText: Message = {
  id: 'peer-text', role: 'external-agent', sender: 'Scout', senderOwnerName: 'Alex', senderType: 'agent',
  senderAvatarSeed: 'cloud_agent_scout', senderProfileImageUrl: 'https://images.test/scout.png',
  showSenderMeta: true, text: 'Plain reply', time: '10:00',
};
const peerAgentTurn: Message = { ...peerAgentText, id: 'peer-turn-row', text: '', turn };

const identities = new Map<string, CanonicalIdentity>([
  ['agent:cloud-agent:cloud_agent_baby', {
    id: 'agent:cloud-agent:cloud_agent_baby', kind: 'agent', displayName: 'babyshu', ownerIdentityId: 'human:acct_me',
    source: 'cloud', humanId: 'acct_me', agentId: 'cloud_agent_baby', avatarKey: 'cloud_agent_baby', profileImageUrl: null,
  } as CanonicalIdentity],
]);
const ownGroupReply: CanonicalSessionMessage = {
  id: 'own-reply', sessionId: 'session:group:team', senderIdentityId: 'agent:cloud-agent:cloud_agent_baby',
  senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello from babyshu',
  content: { sender: 'babyshu', deliveryState: 'complete' }, status: 'complete', sequenceNum: 2,
  createdAtMs: 2, updatedAtMs: 2, sourceTransport: 'cloud-group',
};

async function avatarSources(layout: MessageLayout, msg: Message, densityMode?: TranscriptDensityMode) {
  let sources: string[] = [];
  await withJsdomRoot(async (mount) => {
    try {
      await act(async () => { setMessageLayout(layout); });
      const host = await mount(<MessageBubble msg={msg} densityMode={densityMode} />);
      sources = Array.from(host.querySelectorAll('img'), (img) => img.getAttribute('src') ?? '');
    } finally {
      await act(async () => { setMessageLayout('chat'); });
    }
  });
  return sources;
}

test('chat layout shows the agent avatar on group agent replies', async () => {
  assert.deepEqual(await avatarSources('chat', peerAgentText, 'group-compact'), ['https://images.test/scout.png']);
  assert.deepEqual(await avatarSources('chat', peerAgentTurn, 'group-compact'), ['https://images.test/scout.png']);
});

test('chat layout falls back to the generated seed for the owner agent in a group', async () => {
  const message = mapCanonicalMessage(ownGroupReply, identities, 'human:acct_me');
  assert.ok(message);
  assert.equal(message.senderOwnerName, 'You');
  const sources = await avatarSources('chat', message, 'group-compact');
  assert.equal(sources.length, 1);
  assert.match(sources[0], /preview\/thumbs\/cloud_agent_baby\.png$/);
});

test('chat layout keeps one-to-one agent replies without an avatar', async () => {
  for (const densityMode of [undefined, 'agent-compact', 'contact-compact'] as const) {
    assert.deepEqual(await avatarSources('chat', peerAgentText, densityMode), []);
    assert.deepEqual(await avatarSources('chat', peerAgentTurn, densityMode), []);
  }
});

test('threads layout shows the agent avatar whatever the density', async () => {
  for (const densityMode of [undefined, 'group-compact'] as const) {
    assert.deepEqual(await avatarSources('threads', peerAgentText, densityMode), ['https://images.test/scout.png']);
    assert.deepEqual(await avatarSources('threads', peerAgentTurn, densityMode), ['https://images.test/scout.png']);
  }
});
