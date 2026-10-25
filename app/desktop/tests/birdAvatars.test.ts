import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BIRD_PALETTES,
  BIRD_SPECIES,
  BIRD_TONES,
  birdAvatarFromSeed,
  birdAvatarSeed,
  parseBirdAvatarSeed,
  randomBirdAvatarSeed,
  structuredBirdAvatarSeed,
} from '../src/features/cloud/birdAvatars';

const fixtures: Array<[string, string, string, string]> = [
  ['bird-osprey-color-sky', 'osprey', 'color', 'sky'],
  ['bird-owl-ink-paper', 'owl', 'ink', 'paper'],
  ['bird-jay-mint', 'jay', 'color', 'mint'],
  ['cloud-local-agent', 'sparrow', 'color', 'mint'],
  ['default-agent-acct_123', 'eagle', 'color', 'coral'],
  ['agent_definition_avatar', 'cardinal', 'color', 'butter'],
  ['3f9a1c2e4b5d6f70', 'cockatoo', 'color', 'butter'],
  ['7bbaa257', 'penguin', 'color', 'mint'],
  ['cloud_agent_kordi_pip', 'owl', 'color', 'sakura'],
  ['a', 'toucan', 'color', 'rice'],
  ['', 'hummingbird', 'color', 'mint'],
  ['bird-dragon-color-sky', 'sparrow', 'color', 'sakura'],
];

test('bird tables keep the shared order', () => {
  assert.deepEqual(BIRD_SPECIES.map((entry) => entry.key), [
    'sparrow', 'robin', 'cardinal', 'jay', 'kingfisher', 'hummingbird', 'owl', 'osprey',
    'sparrowhawk', 'eagle', 'penguin', 'puffin', 'toucan', 'heron', 'blackbird', 'cockatoo',
  ]);
  assert.deepEqual(BIRD_TONES.map((entry) => entry.name), ['Color', 'Slate', 'Ink']);
  assert.deepEqual(BIRD_PALETTES.map((entry) => `${entry.key}:${entry.background}`), [
    'paper:#ffffff', 'rice:#fbf5ea', 'coral:#ff8a6b', 'sakura:#f9c6d3',
    'butter:#ffd96a', 'mint:#bfe6cf', 'sky:#a9d8f2', 'lavender:#d6cdf3',
  ]);
});

test('seeds map to the shared bird fixtures', () => {
  for (const [seed, species, tone, palette] of fixtures) {
    assert.deepEqual(birdAvatarFromSeed(seed), { species, tone, palette }, seed);
  }
});

test('only structured seeds parse', () => {
  assert.deepEqual(parseBirdAvatarSeed('bird-owl-ink-paper'), { species: 'owl', tone: 'ink', palette: 'paper' });
  assert.deepEqual(parseBirdAvatarSeed('bird-jay-mint'), { species: 'jay', tone: 'color', palette: 'mint' });
  assert.equal(parseBirdAvatarSeed('bird-dragon-color-sky'), null);
  assert.equal(parseBirdAvatarSeed('bird-owl-neon-paper'), null);
  assert.equal(parseBirdAvatarSeed('bird-owl-ink-paper-extra'), null);
  assert.equal(parseBirdAvatarSeed('cloud-local-agent'), null);
  assert.equal(parseBirdAvatarSeed(''), null);
  assert.equal(birdAvatarSeed('heron', 'slate', 'lavender'), 'bird-heron-slate-lavender');
  assert.equal(structuredBirdAvatarSeed('7bbaa257'), 'bird-penguin-color-mint');
});

test('random seeds are structured', () => {
  for (let index = 0; index < 50; index += 1) {
    const seed = randomBirdAvatarSeed();
    assert.ok(parseBirdAvatarSeed(seed), seed);
    assert.match(seed, /^[A-Za-z0-9_-]{1,128}$/);
  }
});
