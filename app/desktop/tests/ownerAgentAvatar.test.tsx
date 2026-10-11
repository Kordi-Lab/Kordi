import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { resolveKordiProfileAvatarState } from '../src/app/useKordiProfileAvatarState';
import {
  canonicalIdentityAvatarSeed,
  canonicalLocalAgentAvatarSeed,
  DEFAULT_LOCAL_AGENT_AVATAR_SEED,
} from '../src/features/canonical/avatarIdentity';
import { localAgentAvatarFromAccount, setLocalAgentAvatar } from '../src/features/canonical/localAgentAvatar';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { getLocalAgentAvatarSeed, IdentityAvatar } from '../src/kordi-app/components/IdentityAvatar';
import type { CanonicalIdentity, CanonicalSessionState } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { conversation, host } from './helpers/collaborationTranscriptFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const localAgent = {
  id: 'agent:local:123',
  kind: 'agent',
  displayName: 'My Kordi',
  source: 'local',
  ownerIdentityId: 'human:me',
  agentId: 'local:123',
  avatarKey: 'agent:local:123',
  createdAtMs: 1,
  updatedAtMs: 1,
} as CanonicalIdentity;

const canonicalState = {
  profile: { humanIdentityId: 'human:me', activeAgentIdentityId: localAgent.id },
  identities: [localAgent],
} as unknown as CanonicalSessionState;

function account(agentAvatar: Partial<NonNullable<CloudAccount['defaultAgent']>['avatar']> = {}): CloudAccount {
  return {
    accountId: 'acct_x',
    displayName: 'Main Test A',
    primaryEmail: 'a@example.com',
    avatarUrl: null,
    avatar: cloudAccountAvatarFixture,
    defaultAgent: {
      agentId: 'cloud-agent:acct_x',
      displayName: 'KordiMainTestA',
      avatarUrl: null,
      avatar: {
        ...cloudAccountAvatarFixture,
        entityType: 'agent',
        entityId: 'cloud-agent:acct_x',
        style: 'thumbs',
        seed: 'default-agent-acct_x',
        ...agentAvatar,
      },
    },
    nodeId: null,
    passwordSet: true,
  };
}

function collaborationAgentSeed() {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-local-agent-response',
      direction: 'outbound-response',
      sender: 'My Kordi',
      text: 'Done.',
      timeLabel: '17:07',
      timestampMs: 2,
      requestId: 'bridge_req_agent',
      deliveryState: 'responded',
      outreach: null,
    }],
  }), host(), 'My Kordi');
  assert.equal(view.messages[0]?.role, 'owned-agent');
  return view.messages[0]?.senderAvatarSeed;
}

function ownAgentSeeds() {
  return {
    store: getLocalAgentAvatarSeed(),
    canonicalIdentity: canonicalIdentityAvatarSeed(localAgent),
    canonicalLocalAgent: canonicalLocalAgentAvatarSeed(canonicalState),
    collaboration: collaborationAgentSeed(),
  };
}

test('signed out, every own-agent surface uses the local fallback seed', () => {
  setLocalAgentAvatar(null);
  const seeds = ownAgentSeeds();
  assert.deepEqual(new Set(Object.values(seeds)), new Set([DEFAULT_LOCAL_AGENT_AVATAR_SEED]));
  const state = resolveKordiProfileAvatarState({ account: null, canonicalState, collaborationState: null });
  assert.equal(state.localAgentAvatarSeed, DEFAULT_LOCAL_AGENT_AVATAR_SEED);
});

test('signed in, the read model, live turn and collaboration transcript use the account agent seed', () => {
  const signedIn = account();
  try {
    const state = resolveKordiProfileAvatarState({ account: signedIn, canonicalState, collaborationState: null });
    assert.equal(state.localAgentAvatarSeed, 'default-agent-acct_x');
    setLocalAgentAvatar(localAgentAvatarFromAccount(signedIn));
    assert.deepEqual(new Set(Object.values(ownAgentSeeds())), new Set(['default-agent-acct_x']));
  } finally {
    setLocalAgentAvatar(null);
  }
  assert.equal(getLocalAgentAvatarSeed(), DEFAULT_LOCAL_AGENT_AVATAR_SEED);
});

test('a regenerated or missing account agent avatar still resolves to one seed', () => {
  assert.equal(localAgentAvatarFromAccount(account({ seed: 'babytang' }))?.seed, 'babytang');
  assert.equal(localAgentAvatarFromAccount({ accountId: 'acct_y', defaultAgent: null })?.seed, 'default-agent-acct_y');
  assert.equal(localAgentAvatarFromAccount(null), null);
});

test('stale local and stored own-agent rows render the same account agent picture', async () => {
  const uploaded = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';
  await withJsdomRoot(async (mount) => {
    try {
      await act(async () => {
        setLocalAgentAvatar(localAgentAvatarFromAccount(account({ source: 'uploaded', uploadedAsset: uploaded })));
      });
      const sources = [];
      for (const seed of [DEFAULT_LOCAL_AGENT_AVATAR_SEED, 'default-agent-acct_x']) {
        const host = await mount(<IdentityAvatar kind="agent" seed={seed} name="KordiMainTestA" />);
        sources.push(host.querySelector('img')?.getAttribute('src'));
      }
      assert.match(sources[0] ?? '', /\/v1\/avatars\/assets\/ava_0123456789abcdef0123456789abcdef\/256\.jpg$/);
      assert.equal(sources[1], sources[0]);

      const other = await mount(<IdentityAvatar kind="agent" seed="default-agent-acct_peer" name="Peer Kordi" />);
      assert.match(other.querySelector('img')?.getAttribute('src') ?? '', /preview\/thumbs\/default-agent-acct_peer\.png$/);
    } finally {
      setLocalAgentAvatar(null);
    }
  });
});
