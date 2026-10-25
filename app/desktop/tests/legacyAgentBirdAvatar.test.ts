import assert from 'node:assert/strict';
import test from 'node:test';

import { setLocalAgentAvatar } from '../src/features/canonical/localAgentAvatar';
import {
  AGENT_CANONICAL_AVATAR_STYLE,
  CANONICAL_AVATAR_RENDERER_VERSION,
  canonicalAvatarImageUrl,
  generatedAvatarPreviewUrl,
} from '../src/features/cloud/canonicalAvatar';
import { cloudGroupAgentAvatarsByAccount, cloudGroupAgentProfileImageUrl } from '../src/features/cloud/cloudGroupIdentity';
import { cloudGroupParticipantsWithProfiles } from '../src/features/cloud/cloudGroupMessages';
import { factoryAgentAvatarPresentation } from '../src/kordi-app/agents/factoryAgentIdentity';
import type { Agent } from '../src/kordi-app/types';

const RENDERER = CANONICAL_AVATAR_RENDERER_VERSION;
const PRIYA = 'acct_8eea4b7f6d474295b77c68a5a41d0755';
const SEED = `default-agent-${PRIYA}`;
const THUMBS_MARKER = `kordi-avatar://${RENDERER}/thumbs/${SEED}?version=1`;
const PICKED_MARKER = `kordi-avatar://${RENDERER}/kordi-birds/bird-owl-ink-sky?version=2`;
const UPLOADED_MARKER = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';
// What a collaborator's window draws for an agent with no picture: the bird preview of its seed.
const BIRD = generatedAvatarPreviewUrl(AGENT_CANONICAL_AVATAR_STYLE, SEED);

test('a legacy thumbs agent marker draws the bird preview of its seed', () => {
  assert.ok(BIRD);
  assert.match(BIRD, new RegExp(`/v1/avatars/preview/kordi-birds/${SEED}\\.png$`));
  assert.equal(canonicalAvatarImageUrl(THUMBS_MARKER), BIRD);
  // The version is only a cache key on the versioned route; any version maps to the same bird.
  assert.equal(canonicalAvatarImageUrl(THUMBS_MARKER.replace('version=1', 'version=7')), BIRD);
});

test('server-rendered legacy thumbs URLs map to the same-origin bird preview', () => {
  assert.equal(
    canonicalAvatarImageUrl(`https://kordi.test/v1/avatars/${RENDERER}/thumbs/${SEED}.png?v=1`),
    `https://kordi.test/v1/avatars/preview/kordi-birds/${SEED}.png`,
  );
  assert.equal(
    canonicalAvatarImageUrl('https://kordi.test/v1/avatars/preview/thumbs/cloud-local-agent.png'),
    'https://kordi.test/v1/avatars/preview/kordi-birds/cloud-local-agent.png',
  );
  assert.equal(
    canonicalAvatarImageUrl('http://127.0.0.1:17081/v1/avatars/dicebear-rust-9.0.0/thumbs/seed_1.png?v=4'),
    'http://127.0.0.1:17081/v1/avatars/preview/kordi-birds/seed_1.png',
  );
  // A URL whose seed is not a valid avatar seed is left alone.
  const invalid = 'https://kordi.test/v1/avatars/preview/thumbs/bad%20seed.png';
  assert.equal(canonicalAvatarImageUrl(invalid), invalid);
});

test('picked birds, uploaded photos, and human avatars keep their images', () => {
  assert.match(
    canonicalAvatarImageUrl(PICKED_MARKER) ?? '',
    new RegExp(`/v1/avatars/${RENDERER}/kordi-birds/bird-owl-ink-sky\\.png\\?v=2$`),
  );
  assert.match(
    canonicalAvatarImageUrl(UPLOADED_MARKER) ?? '',
    /\/v1\/avatars\/assets\/ava_0123456789abcdef0123456789abcdef\/256\.jpg$/,
  );
  assert.match(
    canonicalAvatarImageUrl(`kordi-avatar://${RENDERER}/lorelei/acct_x?version=3`) ?? '',
    new RegExp(`/v1/avatars/${RENDERER}/lorelei/acct_x\\.png\\?v=3$`),
  );
  for (const unchanged of [
    `https://kordi.test/v1/avatars/${RENDERER}/kordi-birds/bird-jay-mint.png?v=2`,
    `https://kordi.test/v1/avatars/${RENDERER}/lorelei/acct_x.png?v=3`,
    'https://kordi.test/v1/avatars/preview/lorelei/acct_x.png',
    'https://kordi.test/v1/avatars/assets/ava_0123456789abcdef0123456789abcdef/256.jpg',
    'https://images.test/thumbs/agent.png',
    'data:image/png;base64,avatar',
  ]) {
    assert.equal(canonicalAvatarImageUrl(unchanged), unchanged);
  }
});

test('the Blueprint picker gets the bird for a stale stored or overridden thumbs URL', () => {
  const agent = {
    id: 'cloud_agent_writer',
    name: 'Writer',
    avatarSeed: 'cloud_agent_writer',
    profileImageUrl: `https://kordi.test/v1/avatars/${RENDERER}/thumbs/writer_seed.png?v=1`,
  } as unknown as Agent;
  assert.equal(
    factoryAgentAvatarPresentation(agent).avatarUrl,
    'https://kordi.test/v1/avatars/preview/kordi-birds/writer_seed.png',
  );
});

test('the own agent avatar in Factory is the bird its untouched thumbs marker maps to', () => {
  setLocalAgentAvatar({ accountId: PRIYA, seed: SEED, imageUrl: THUMBS_MARKER });
  try {
    const ownAgent = { id: 'desktop:local-agent', name: 'Kordi', avatarSeed: SEED, isOwned: true } as unknown as Agent;
    assert.equal(factoryAgentAvatarPresentation(ownAgent).avatarUrl, BIRD);
  } finally {
    setLocalAgentAvatar(null);
  }
});

test('each member agent picture comes from profiles first, then envelope values', () => {
  const avatars = cloudGroupAgentAvatarsByAccount([
    { accountId: PRIYA, displayName: 'Priya', avatarUrl: null, agentAvatarUrl: THUMBS_MARKER },
    { accountId: 'acct_envelope', displayName: 'Envelope', avatarUrl: null, agentId: 'cloud-agent:acct_envelope', agentAvatarUrl: UPLOADED_MARKER },
    { accountId: 'acct_none', displayName: 'None', avatarUrl: null, agentAvatarUrl: null },
  ], [
    { accountId: PRIYA, defaultAgent: { agentId: `cloud-agent:${PRIYA}`, displayName: "Priya Tester's Kordi", avatarUrl: PICKED_MARKER } as never },
    { accountId: 'acct_no_agent', defaultAgent: null },
  ]);
  assert.deepEqual([...avatars.keys()].sort(), [PRIYA, 'acct_envelope'].sort());
  assert.deepEqual(avatars.get(PRIYA), { accountId: PRIYA, agentId: `cloud-agent:${PRIYA}`, agentAvatarUrl: PICKED_MARKER });
  assert.match(cloudGroupAgentProfileImageUrl(avatars.get(PRIYA), `cloud-agent:${PRIYA}`) ?? '', /kordi-birds\/bird-owl-ink-sky\.png\?v=2$/);
  assert.match(cloudGroupAgentProfileImageUrl(avatars.get('acct_envelope'), 'cloud-agent:acct_envelope') ?? '', /assets\/ava_0123456789abcdef0123456789abcdef\/256\.jpg$/);
  // Another agent of the same member never takes the default agent's picture.
  assert.equal(cloudGroupAgentProfileImageUrl(avatars.get(PRIYA), 'cloud_agent_other'), null);
});

test('the envelope marker form reaches the collaborator as the bird', () => {
  const avatars = cloudGroupAgentAvatarsByAccount(
    [{ accountId: PRIYA, displayName: 'Priya', avatarUrl: null, agentId: `cloud-agent:${PRIYA}`, agentAvatarUrl: THUMBS_MARKER, agentAvatarSeed: SEED }],
    [],
  );
  assert.equal(cloudGroupAgentProfileImageUrl(avatars.get(PRIYA), `cloud-agent:${PRIYA}`), BIRD);
});

test('the participant snapshot behind routing stays free of agent fields', () => {
  const participants = cloudGroupParticipantsWithProfiles(
    [{ accountId: PRIYA, displayName: 'Priya', avatarUrl: null, agentId: `cloud-agent:${PRIYA}`, agentAvatarUrl: THUMBS_MARKER, role: 'person' }],
    [{ accountId: PRIYA, displayName: 'Priya', avatarUrl: null, defaultAgent: { agentId: `cloud-agent:${PRIYA}`, displayName: 'Kordi', avatarUrl: PICKED_MARKER, avatar: { seed: 'bird-owl-ink-sky' } } as never }],
  );
  assert.deepEqual(participants, [{ accountId: PRIYA, displayName: 'Priya', avatarUrl: null, role: 'person' }]);
});
