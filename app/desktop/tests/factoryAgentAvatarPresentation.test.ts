import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocalAgentAvatar } from '@/features/canonical/localAgentAvatar';
import { factoryAgentAvatarPresentation } from '@/kordi-app/agents/factoryAgentIdentity';
import type { Agent } from '@/kordi-app/types';

const ownAgent = {
  id: 'desktop:local-agent',
  name: "Priya Tester's Kordi",
  avatarSeed: 'default-agent-acct_owner',
  isOwned: true,
} as unknown as Agent;

test('the own agent avatar marker from the account snapshot becomes an image url for the Blueprint picker', () => {
  setLocalAgentAvatar({
    accountId: 'acct_owner',
    seed: 'bird-owl-color-sakura',
    imageUrl: 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/kordi-birds/bird-owl-color-sakura?version=5',
  });
  try {
    const { avatarUrl } = factoryAgentAvatarPresentation(ownAgent);
    assert.ok(avatarUrl, 'an avatar url is produced');
    assert.ok(!avatarUrl.startsWith('kordi-avatar://'), `marker must be converted, got ${avatarUrl}`);
    assert.match(avatarUrl, /\/v1\/avatars\/dicebear-rust-10\.6\.0-styles-10\.5\.0\/kordi-birds\/bird-owl-color-sakura\.png\?v=5$/u);
  } finally {
    setLocalAgentAvatar(null);
  }
});
