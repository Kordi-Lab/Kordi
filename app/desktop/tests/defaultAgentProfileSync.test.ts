import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  legacyDefaultAgentProfileMigrationOwner,
  legacyDefaultAgentProfileUpdate,
  markLegacyDefaultAgentProfileMigrated,
  shouldMigrateLegacyDefaultAgentProfile,
} from '../src/features/cloud/cloudAgentIdentity';

test('legacy local default-agent identity migrates once into the cloud profile', () => {
  assert.deepEqual(legacyDefaultAgentProfileUpdate({
    localName: 'BabyTREE',
    localAvatar: 'https://kordi.test/v1/avatars/preview/thumbs/baby_tree.png',
    remoteDisplayName: 'Kordi',
    remoteAvatarVersion: 1,
  }), {
    agentDisplayName: 'BabyTREE',
    agentAvatarMutation: {
      action: 'regenerate',
      seed: 'baby_tree',
      expectedVersion: 1,
    },
  });
  assert.equal(legacyDefaultAgentProfileUpdate({
    localName: 'BabyTREE',
    localAvatar: 'https://kordi.test/v1/avatars/preview/thumbs/old.png',
    remoteDisplayName: 'BabyTREE',
    remoteAvatarVersion: 2,
  }), null);
});

test('legacy default-agent profile migration records its owning Cloud account', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  assert.equal(legacyDefaultAgentProfileMigrationOwner(storage), null);
  assert.equal(shouldMigrateLegacyDefaultAgentProfile(storage), true);
  markLegacyDefaultAgentProfileMigrated(storage, 'acct_first');
  assert.equal(legacyDefaultAgentProfileMigrationOwner(storage), 'acct_first');
  assert.equal(shouldMigrateLegacyDefaultAgentProfile(storage), false);
});
