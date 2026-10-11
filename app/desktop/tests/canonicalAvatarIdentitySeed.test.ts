import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalIdentityAvatarSeed,
  cloudDefaultAgentAvatarSeed,
  DEFAULT_LOCAL_AGENT_AVATAR_SEED,
} from '../src/features/canonical/avatarIdentity';
import type { CanonicalIdentity } from '../src/kordi-app/types';

function identity(overrides: Partial<CanonicalIdentity>): CanonicalIdentity {
  return {
    id: 'agent:test',
    kind: 'agent',
    displayName: 'Test',
    source: 'cloud',
    avatarKey: 'avatar-key',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

test('cloud default agent identities use the server default agent seed', () => {
  assert.equal(canonicalIdentityAvatarSeed(identity({
    id: 'agent:cloud-agent:cloud-agent:acct_x',
    agentId: 'cloud-agent:acct_x',
    avatarKey: 'cloud-agent:acct_x',
    metadata: { cloudGroupAgent: true },
  })), 'default-agent-acct_x');
  assert.equal(canonicalIdentityAvatarSeed(identity({ agentId: 'cloud-self:acct_x' })), 'default-agent-acct_x');
});

test('local agents keep the local agent seed', () => {
  assert.equal(
    canonicalIdentityAvatarSeed(identity({ source: 'local', agentId: 'cloud-agent:acct_x' })),
    DEFAULT_LOCAL_AGENT_AVATAR_SEED,
  );
});

test('custom cloud agent ids stay unchanged', () => {
  assert.equal(canonicalIdentityAvatarSeed(identity({ agentId: 'cloud_agent_abc' })), 'cloud_agent_abc');
  assert.equal(cloudDefaultAgentAvatarSeed('cloud-agent:cloud_agent_abc'), null);
  assert.equal(cloudDefaultAgentAvatarSeed('cloud_agent_abc'), null);
});

test('human identities keep their avatar key', () => {
  assert.equal(canonicalIdentityAvatarSeed(identity({
    kind: 'human',
    humanId: 'acct_x',
    agentId: 'cloud-agent:acct_x',
    avatarKey: 'human-avatar-seed',
  })), 'human-avatar-seed');
});
