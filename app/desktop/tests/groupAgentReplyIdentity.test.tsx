import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { setMessageLayout } from '../src/app/messageLayoutPreference';
import { localOwnedAgentSenderLabel } from '../src/app/viewModels/helpers';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { agentMessageAvatarSeed } from '../src/features/chat/agentMessageAvatar';
import { cloudGroupAgentProfileImageUrl } from '../src/features/cloud/cloudGroupIdentity';
import { setLocalProfileAvatarSeed } from '../src/kordi-app/components/IdentityAvatar';
import { setActiveLocalProfileIdentity } from '../src/kordi-app/components/localProfileIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import { SourceMessageQuote } from '../src/kordi-app/components/transcriptReplyAttribution';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const CHANNEL_TITLE = 'Just for random test';
const CHANNEL_PICTURE = 'https://images.test/channel.png';

const identities = new Map<string, CanonicalIdentity>([
  ['human:acct_me', {
    id: 'human:acct_me', kind: 'human', displayName: 'Shu Yang', source: 'local', humanId: 'acct_me',
    avatarKey: 'acct_me_seed', profileImageUrl: 'https://images.test/me.png',
  } as CanonicalIdentity],
  ['agent:cloud-agent:cloud_agent_baby', {
    id: 'agent:cloud-agent:cloud_agent_baby', kind: 'agent', displayName: 'babyshu', ownerIdentityId: 'human:acct_me',
    source: 'cloud', humanId: 'acct_me', agentId: 'cloud_agent_baby', avatarKey: 'cloud_agent_baby', profileImageUrl: null,
  } as CanonicalIdentity],
]);

const groupReply: CanonicalSessionMessage = {
  id: 'reply', sessionId: 'session:group:random', senderIdentityId: 'agent:cloud-agent:cloud_agent_baby',
  senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello from babyshu',
  content: { sender: 'babyshu', deliveryState: 'complete' }, status: 'complete', sequenceNum: 2,
  createdAtMs: 2, updatedAtMs: 2, sourceTransport: 'cloud-group',
};

async function inThreads(run: (mount: (element: React.ReactElement) => Promise<HTMLElement>) => Promise<void>) {
  await withJsdomRoot(async (mount) => {
    try {
      await act(async () => {
        setMessageLayout('threads');
        setActiveLocalProfileIdentity({ avatarSeed: 'acct_me_seed', displayName: 'Shu Yang', profileImageUrl: null });
        setLocalProfileAvatarSeed('acct_me_seed');
      });
      await run(mount);
    } finally {
      setMessageLayout('chat');
      setActiveLocalProfileIdentity({ avatarSeed: null, displayName: null, profileImageUrl: null });
    }
  });
}

test('an owned agent reply in a group channel shows the agent, not the channel', async () => {
  const message = mapCanonicalMessage(groupReply, identities, 'human:acct_me');
  assert.ok(message);
  assert.equal(message.sender, 'babyshu');
  assert.equal(message.senderOwnerName, 'You');
  assert.equal(message.senderAvatarSeed, 'cloud_agent_baby');

  await inThreads(async (mount) => {
    const host = await mount(<MessageBubble msg={message} />);
    assert.equal(host.querySelector('.app-thread-message-author')?.textContent, 'babyshu');
    assert.ok(!host.textContent?.includes(CHANNEL_TITLE));
    assert.match(host.textContent ?? '', /Owner · You/);
    const src = host.querySelector('img')?.getAttribute('src') ?? '';
    assert.match(src, /preview\/thumbs\/cloud_agent_baby\.png$/);
  });
});

test('a configured agent picture is shown on its group replies', async () => {
  const configured = new Map(identities);
  configured.set('agent:cloud-agent:cloud_agent_baby', {
    ...identities.get('agent:cloud-agent:cloud_agent_baby')!, profileImageUrl: 'https://images.test/babyshu.png',
  });
  const message = mapCanonicalMessage(groupReply, configured, 'human:acct_me');
  assert.equal(message?.senderProfileImageUrl, 'https://images.test/babyshu.png');

  const member = { accountId: 'acct_peer', agentId: 'cloud-agent:acct_peer', agentAvatarUrl: 'https://images.test/peer-agent.png' };
  assert.equal(cloudGroupAgentProfileImageUrl(member, 'cloud-agent:acct_peer'), 'https://images.test/peer-agent.png');
  assert.equal(cloudGroupAgentProfileImageUrl(member, 'cloud_agent_other'), null);
  assert.equal(cloudGroupAgentProfileImageUrl(undefined, 'cloud-agent:acct_peer'), null);
});

test('an unknown agent never takes the group picture or the local agent avatar', async () => {
  const unknown: Message = {
    id: 'unknown', role: 'external-agent', sender: 'Visiting Agent', senderType: 'agent', text: '', time: '10:00',
    turn: { id: 'unknown-turn', sessionId: 'session:group:random', prompt: '', status: 'complete', message: 'Complete', assistantText: 'hi', thinkingText: '', tools: [], completed: true, succeeded: true, error: null },
  };
  const seed = agentMessageAvatarSeed(unknown, 'default-agent-acct_me');
  assert.notEqual(seed, 'default-agent-acct_me');
  assert.match(seed, /^agent-visiting-agent-/);
  assert.equal(agentMessageAvatarSeed({ role: 'owned-agent', sender: 'babyshu' }, 'default-agent-acct_me'), 'default-agent-acct_me');

  await inThreads(async (mount) => {
    const host = await mount(<MessageBubble msg={unknown} />);
    assert.equal(host.querySelector('.app-thread-message-author')?.textContent, 'Visiting Agent');
    const src = host.querySelector('img')?.getAttribute('src') ?? '';
    assert.notEqual(src, CHANNEL_PICTURE);
    assert.match(src, new RegExp(`preview/thumbs/${seed}\\.png$`));
  });
});

test('the live agent label in a group is never a member name', () => {
  const group = {
    canonicalParticipants: [
      { id: 'human:acct_me', name: 'Shu Yang', kind: 'human' as const, role: 'self' as const },
      { id: 'human:acct_peer', name: 'Peer Person', kind: 'human' as const, role: 'participant' as const },
    ],
    participants: ['Shu Yang', 'Peer Person'],
    messages: [],
  };
  assert.equal(localOwnedAgentSenderLabel(group), 'My Kordi');
});

test('the quote line shows a member picture and the viewer avatar', async () => {
  await inThreads(async (mount) => {
    const member = await mount(<SourceMessageQuote sourceMessage={{
      messageId: 'm', senderLabel: 'Peer Person', senderKind: 'human', senderAvatarSeed: 'acct_peer_seed',
      senderProfileImageUrl: 'https://images.test/peer.png', text: 'hi',
    }} />);
    assert.equal(member.querySelector('img')?.getAttribute('src'), 'https://images.test/peer.png');

    const self = await mount(<SourceMessageQuote sourceMessage={{ messageId: 'm', senderLabel: 'Shu Yang', text: '@babyshu test' }} />);
    assert.match(self.querySelector('img')?.getAttribute('src') ?? '', /preview\/lorelei\/acct_me_seed\.png$/);
    assert.match(self.textContent ?? '', /^@Shu Yang /);
  });
});
