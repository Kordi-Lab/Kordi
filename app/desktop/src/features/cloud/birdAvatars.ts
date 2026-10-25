/**
 * Kordi bird avatars for agents. The server renders the birds; this table only maps seeds to
 * a species, tone and palette so pickers can show and write structured seeds. Keep the order
 * in step with the server and iOS tables.
 */
export const BIRD_SPECIES = [
  { key: 'sparrow', name: 'Sparrow' },
  { key: 'robin', name: 'Robin' },
  { key: 'cardinal', name: 'Cardinal' },
  { key: 'jay', name: 'Jay' },
  { key: 'kingfisher', name: 'Kingfisher' },
  { key: 'hummingbird', name: 'Hummingbird' },
  { key: 'owl', name: 'Owl' },
  { key: 'osprey', name: 'Osprey' },
  { key: 'sparrowhawk', name: 'Sparrowhawk' },
  { key: 'eagle', name: 'Eagle' },
  { key: 'penguin', name: 'Penguin' },
  { key: 'puffin', name: 'Puffin' },
  { key: 'toucan', name: 'Toucan' },
  { key: 'heron', name: 'Heron' },
  { key: 'blackbird', name: 'Blackbird' },
  { key: 'cockatoo', name: 'Cockatoo' },
] as const;

export const BIRD_TONES = [
  { key: 'color', name: 'Color' },
  { key: 'slate', name: 'Slate' },
  { key: 'ink', name: 'Ink' },
] as const;

export const BIRD_PALETTES = [
  { key: 'paper', name: 'Paper', background: '#ffffff' },
  { key: 'rice', name: 'Rice', background: '#fbf5ea' },
  { key: 'coral', name: 'Coral', background: '#ff8a6b' },
  { key: 'sakura', name: 'Sakura', background: '#f9c6d3' },
  { key: 'butter', name: 'Butter', background: '#ffd96a' },
  { key: 'mint', name: 'Mint', background: '#bfe6cf' },
  { key: 'sky', name: 'Sky', background: '#a9d8f2' },
  { key: 'lavender', name: 'Lavender', background: '#d6cdf3' },
] as const;

export type BirdSpecies = (typeof BIRD_SPECIES)[number]['key'];
export type BirdTone = (typeof BIRD_TONES)[number]['key'];
export type BirdPalette = (typeof BIRD_PALETTES)[number]['key'];
export type BirdAvatar = { species: BirdSpecies; tone: BirdTone; palette: BirdPalette };

const speciesKeys: readonly string[] = BIRD_SPECIES.map((entry) => entry.key);
const toneKeys: readonly string[] = BIRD_TONES.map((entry) => entry.key);
const paletteKeys: readonly string[] = BIRD_PALETTES.map((entry) => entry.key);

export function birdAvatarSeed(species: BirdSpecies, tone: BirdTone, palette: BirdPalette) {
  return `bird-${species}-${tone}-${palette}`;
}

/** Reads `bird-<species>-<tone>-<palette>` or `bird-<species>-<palette>` (tone color); null otherwise. */
export function parseBirdAvatarSeed(seed: string | null | undefined): BirdAvatar | null {
  const parts = seed?.trim().split('-') ?? [];
  if (parts[0] !== 'bird' || (parts.length !== 3 && parts.length !== 4)) return null;
  const species = parts[1];
  const tone = parts.length === 4 ? parts[2] : 'color';
  const palette = parts[parts.length - 1];
  if (!speciesKeys.includes(species) || !toneKeys.includes(tone) || !paletteKeys.includes(palette)) return null;
  return { species, tone, palette } as BirdAvatar;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The bird a seed renders as: structured seeds as written, any other seed hashed with tone color. */
export function birdAvatarFromSeed(seed: string): BirdAvatar {
  const parsed = parseBirdAvatarSeed(seed);
  if (parsed) return parsed;
  const hash = fnv1a32(seed);
  return {
    species: BIRD_SPECIES[hash % BIRD_SPECIES.length].key,
    tone: 'color',
    palette: BIRD_PALETTES[(hash >>> 8) % BIRD_PALETTES.length].key,
  };
}

function randomIndex(length: number) {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint32Array(1))[0] % length;
  }
  return Math.floor(Math.random() * length);
}

export function randomBirdAvatarSeed() {
  return birdAvatarSeed(
    BIRD_SPECIES[randomIndex(BIRD_SPECIES.length)].key,
    BIRD_TONES[randomIndex(BIRD_TONES.length)].key,
    BIRD_PALETTES[randomIndex(BIRD_PALETTES.length)].key,
  );
}

/** The structured seed for any seed, so a regenerate always lands on the bird style. */
export function structuredBirdAvatarSeed(seed: string) {
  const bird = birdAvatarFromSeed(seed);
  return birdAvatarSeed(bird.species, bird.tone, bird.palette);
}
