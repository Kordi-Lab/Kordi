import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveKordiProfileAvatarState } from '../src/app/useKordiProfileAvatarState';
import type {
  DesktopCollaborationAgent,
  DesktopCollaborationHost,
  DesktopCollaborationState,
} from '../src/kordi-app/types';

function collaborationAgent(
  id: string,
  overrides: Partial<DesktopCollaborationAgent> = {},
): DesktopCollaborationAgent {
  return {
    id,
    label: `${id} label`,
    runtime: 'cloud',
    isDefault: false,
    isActive: false,
    registered: true,
    ...overrides,
  };
}

function collaborationHost(
  id: string,
  overrides: Partial<DesktopCollaborationHost> = {},
): DesktopCollaborationHost {
  return {
    id,
    registered: true,
    connected: true,
    serverUrl: 'https://kordi.ai',
    displayName: `${id} display`,
    ownerName: `${id} owner`,
    endpoint: 'cloud',
    tokenPresent: true,
    humanId: `${id}-human`,
    discoveryMode: 'cloud',
    agents: [],
    visiblePeers: [],
    visiblePeerCount: 0,
    projects: [],
    ...overrides,
  };
}

function collaborationState(
  hosts: DesktopCollaborationHost[],
  activeHostId?: string,
): DesktopCollaborationState {
  return {
    activeHostId,
    hosts,
    conversations: [],
  };
}

test('profile avatar state uses the active collaboration host and agent', () => {
  const inactiveHost = collaborationHost('inactive');
  const activeAgent = collaborationAgent('active-agent', {
    label: 'Active Kordi',
    isActive: true,
    nodeId: 'active-agent-node',
  });
  const activeHost = collaborationHost('active', {
    activeAgentId: activeAgent.id,
    agents: [activeAgent],
    ownerName: 'Cloud Owner',
    profileImageUrl: 'https://cdn.kordi.ai/profile.png',
  });

  const state = resolveKordiProfileAvatarState({
    account: null,
    canonicalState: null,
    collaborationState: collaborationState(
      [inactiveHost, activeHost],
      activeHost.id,
    ),
  });

  assert.equal(state.localProfileAvatarSeed, 'active-human');
  assert.equal(state.localProfileDisplayName, 'Cloud Owner');
  assert.equal(
    state.localProfileImageUrl,
    'https://cdn.kordi.ai/profile.png',
  );
  assert.equal(state.localAgentAvatarSeed, activeAgent.id);
  assert.equal(state.localAgentDisplayName, 'Active Kordi');
});

test('cloud account profile identity takes precedence over host fallbacks', () => {
  const state = resolveKordiProfileAvatarState({
    account: {
      accountId: 'account-1',
      displayName: 'Account Owner',
      primaryEmail: 'owner@example.com',
      avatarUrl: 'https://cdn.kordi.ai/account.png',
      avatar: {
        entityType: 'human',
        entityId: 'account-1',
        source: 'uploaded',
        style: 'lorelei',
        seed: 'account_owner_seed',
        rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
        uploadedAsset: 'https://cdn.kordi.ai/account.png',
        version: 1,
        updatedAt: '2026-08-19T00:00:00Z',
      },
      nodeId: null,
      passwordSet: true,
    },
    canonicalState: null,
    collaborationState: collaborationState([
      collaborationHost('host', {
        ownerName: 'Host Owner',
        profileImageUrl: 'https://cdn.kordi.ai/host.png',
      }),
    ]),
  });

  assert.equal(state.localProfileAvatarSeed, 'account_owner_seed');
  assert.equal(state.localProfileDisplayName, 'Account Owner');
  assert.equal(
    state.localProfileImageUrl,
    'https://cdn.kordi.ai/account.png',
  );
  assert.equal(state.shouldPersistProfileSeed, false);
});

test('cloud account email keeps generated self avatars stable when a display name is absent', () => {
  const state = resolveKordiProfileAvatarState({
    account: {
      accountId: 'account-2',
      displayName: null,
      primaryEmail: 'owner@example.com',
      avatarUrl: null,
      avatar: {
        entityType: 'human',
        entityId: 'account-2',
        source: 'generated',
        style: 'lorelei',
        seed: 'account_email_seed',
        rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
        uploadedAsset: null,
        version: 1,
        updatedAt: '2026-08-19T00:00:00Z',
      },
      nodeId: null,
      passwordSet: true,
    },
    canonicalState: null,
    collaborationState: null,
  });

  assert.equal(state.localProfileDisplayName, 'owner@example.com');
});
