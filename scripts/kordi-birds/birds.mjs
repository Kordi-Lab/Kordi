/* Kordi agent bird avatars: a parametric paper-cut SVG generator.
 * Source of truth for the `kordi-birds` avatar style. scripts/kordi-birds/generate.mjs
 * turns this module into the browser preview script and the server templates.
 * Every species is one continuous silhouette (back, nape, crown, chin,
 * throat, chest) plus a few flat cut shapes, so the set reads as a family.
 * Output uses only paths, rects, circles, ellipses, linear gradients and clip
 * paths so the server rasterizer (resvg) draws it exactly like a browser. */

export const BG_PLACEHOLDER = '__BG__';


export const SPECIES = [
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
];

export const PALETTES = [
  { key: 'paper', name: 'Paper', bg: '#ffffff' },
  { key: 'rice', name: 'Rice', bg: '#fbf5ea' },
  { key: 'coral', name: 'Coral', bg: '#ff8a6b' },
  { key: 'sakura', name: 'Sakura', bg: '#f9c6d3' },
  { key: 'butter', name: 'Butter', bg: '#ffd96a' },
  { key: 'mint', name: 'Mint', bg: '#bfe6cf' },
  { key: 'sky', name: 'Sky', bg: '#a9d8f2' },
  { key: 'lavender', name: 'Lavender', bg: '#d6cdf3' },
];

const INK = '#1f1a17';
const CREAM = '#f1ebe0';
const GREY = '#b9b2a9';
const AMBER = '#f7b32b';

/* Body gradients, lighter at the top. `crest` matches the top stop; `nape` is a shade darker. */
const BODIES = {
  slate: { top: '#7a746e', bottom: '#443f3b', crest: '#736d67', nape: '#5a544f' },
  ink: { top: '#2a2522', bottom: '#1a1613', crest: '#2a2522', nape: '#161210' },
  cream: { top: '#f6f1e7', bottom: '#ddd6c9', crest: '#f6f1e7', nape: '#ddd6c9' },
};

const SIL = 'M8,128 C8,100 18,82 34,72 C28,58 30,38 42,26 C52,16 70,14 82,22 C92,28 97,40 97,52 C97,62 92,72 88,80 C100,92 110,108 112,128 Z';
const SIL_LOW = 'M8,128 C8,100 18,82 34,74 C30,62 32,44 44,34 C54,26 70,24 80,30 C90,36 95,44 95,52 C95,62 91,72 88,80 C100,92 110,108 112,128 Z';
const SIL_OWL = 'M8,128 C8,100 18,84 34,74 C24,60 26,34 42,20 C56,8 80,10 92,22 C100,32 100,44 98,54 C96,64 92,72 88,80 C100,92 110,108 112,128 Z';
const SIL_OWL_FRONT = 'M8,128 C8,100 24,84 44,80 L84,80 C104,84 120,100 120,128 Z M30,52 a34,34 0 1,1 68,0 a34,34 0 1,1 -68,0 Z';
const CHEST = 'M46,128 C48,100 60,84 78,78 C88,76 94,84 98,96 C103,108 105,118 105,128 Z';

const BEAKS = {
  hook: 'M95,45 C108,43 120,47 121,55 C121,61 117,65 114,64 C113,59 108,56 103,56 L95,59 Z',
  cone: 'M95,46 L121,53 L95,60 Z',
  dagger: 'M95,47 L127,53 L95,58 Z',
  needle: 'M95,49 L128,52 L95,55 Z',
  straight: 'M95,46 L119,51 L119,56 L95,60 Z',
};

const NAPE_SPIKES = 'M34,70 L18,66 L32,60 L16,56 L32,50 L22,42 L36,46 Z';

let counter = 0;
const p = (d, fill, extra = '') => `<path d="${d}" fill="${fill}"${extra}/>`;
const circle = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const ellipse = (cx, cy, rx, ry, fill) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;

/* Mono tones: monochrome bird, amber beak. Penguin and blackbird stay ink; cockatoo is cream. */
const MONO_BODY = { penguin: 'ink', blackbird: 'ink', cockatoo: 'cream' };

/* Colour tone: natural species colours, soft vertical gradient (about 12% darker at the bottom). */
const COLOR = {
  sparrow: { top: '#b07e55', bottom: '#7f5436', cap: '#7c8188', cheek: '#f3e9d6', bib: '#2b2622', chest: '#e9dcc4', beak: '#8a6a3a' },
  robin: { top: '#9a8763', bottom: '#766347', face: '#ee6a3b', breast: '#ee6a3b', belly: '#f2ece0', beak: '#6b5a3a' },
  cardinal: { top: '#e64a3c', bottom: '#b42b22', crest: '#e64a3c', mark: '#1f1a17', beak: '#f0a23c' },
  jay: { top: '#5f9ae8', bottom: '#2f66b8', crest: '#5f9ae8', face: '#f4f6f9', chest: '#f4f6f9', mark: '#1f1a17', beak: '#2b2b2b' },
  kingfisher: { top: '#35b3e3', bottom: '#176f9e', nape: '#35b3e3', chest: '#ec8a3a', face: '#f4f1ea', beak: '#2a2a2a' },
  hummingbird: { top: '#43bf86', bottom: '#237a55', gorget: '#d8324a', chest: '#e9f1ea', beak: '#2a2a2a' },
  owl: { top: '#a3835f', bottom: '#6e5238', crest: '#a3835f', disc: '#dcc19a', iris: '#f2c531', beak: '#d9a441', chest: '#e6d6bf' },
  osprey: { top: '#66503d', bottom: '#3b2b1f', nape: '#4f3d2e', face: '#f4f1ea', chest: '#f4f1ea', stripe: '#3b2b1f', iris: '#f2c531', beak: '#3a3a3a' },
  sparrowhawk: { top: '#7a8c9e', bottom: '#46566a', nape: '#5d6e80', chest: '#f1e9d9', bars: '#c8794b', iris: '#f2c531', beak: '#3a3a3a', cere: '#f2c531' },
  eagle: { top: '#614634', bottom: '#382719', head: '#f5f2ec', beak: '#f2b632', iris: '#f2c531' },
  penguin: { top: '#3a3f46', bottom: '#15181c', face: '#f4f3ef', chest: '#f4f3ef', beak: '#f29a2e' },
  puffin: { top: '#3a3f46', bottom: '#15181c', face: '#f4f3ef', chest: '#f4f3ef', beak: '#f28b2b', band: '#6f8da5', ridge: '#f2c531' },
  toucan: { top: '#3a3f46', bottom: '#15181c', face: '#f5d45f', beak: '#f39a2b', beak2: '#e07a1f', tip: '#111111', iris: '#4b9fd6' },
  heron: { top: '#c3cad0', bottom: '#8f9aa3', face: '#f4f3ef', chest: '#f4f3ef', plume: '#22262b', stripe: '#22262b', beak: '#f2c531' },
  blackbird: { top: '#3a3f46', bottom: '#15181c', beak: '#f2b632', iris: '#f2b632' },
  cockatoo: { top: '#ffffff', bottom: '#e4ded2', crestAccent: '#f2c94c', chest: '#fbf8f1', beak: '#6b6b6b' },
};

function resolveColors(speciesKey, tone) {
  if (tone === 'color') {
    const c = COLOR[speciesKey] || COLOR.sparrow;
    return { color: true, crest: c.top, nape: c.bottom, face: '#f4f3ef', mark: INK, ...c };
  }
  const body = BODIES[MONO_BODY[speciesKey] || (tone === 'ink' ? 'ink' : 'slate')];
  return { color: false, ...body, face: CREAM, chest: CREAM, mark: INK, beak: AMBER };
}

/* Eyes. Mono: cream ring or amber raptor iris. Colour: iris, black pupil, white specular dot. */
const BROW = 'M74,36 L92,38 L92,41 L74,40 Z';
const BROW_HEAVY = 'M72,35 L93,37 L93,41.5 L72,40 Z';
const BROW_OWL = 'M70,31 L94,33.5 L94,37.5 L70,36 Z';
function eye(style, k) {
  if (style === 'owlFront') {
    return [50, 78].map((x) => k.color
      ? circle(x, 50, 8, k.iris || AMBER) + circle(x, 50.5, 4, '#111') + circle(x - 1.6, 48.7, 1.6, '#fff')
      : circle(x, 50, 8, AMBER) + circle(x, 50.5, 4, INK)).join('');
  }
  const big = style === 'owl';
  const raptor = style === 'raptor' || style === 'raptorHeavy' || style === 'amber' || big;
  const cx = big ? 82 : 83;
  const ir = big ? 8 : raptor ? 6.5 : k.color ? 5 : style === 'dot' ? 4 : 5.5;
  const pr = big ? 4.5 : raptor ? 3.4 : 3;
  const px = big ? 83.5 : 84;
  const brow = style === 'raptor' ? BROW : style === 'raptorHeavy' ? BROW_HEAVY : big ? BROW_OWL : '';
  let out;
  if (k.color) {
    out = circle(cx, 42, ir, k.iris || '#2b2622') + circle(px, 42.5, pr, '#111') +
      circle(px - pr * 0.4, 42.5 - pr * 0.45, 1.6, '#fff');
  } else if (raptor) {
    out = circle(cx, 42, ir, AMBER) + circle(px, 42.5, pr, INK);
  } else if (style === 'dot') {
    out = circle(83.5, 42.5, 4, INK);
  } else {
    out = circle(83, 42, 5.5, CREAM) + circle(84, 42.5, 3, INK);
  }
  return out + (brow ? p(brow, INK) : '');
}

const THROAT = 'M60,52 C70,48 86,48 98,54 L98,62 C95,70 91,76 88,82 C80,80 68,72 60,60 Z';
const FRONT_THROAT = 'M76,60 C84,58 92,58 98,56 L96,70 C90,76 82,76 76,70 Z';

/* Each builder returns layer data; birdSvg draws them in one fixed order:
 * behind -> silhouette -> chest -> marks (clipped to silhouette) -> beak -> eye. */
const BUILD = {
  sparrow: (k) => ({
    beak: BEAKS.cone,
    marks: (k.cap ? ellipse(62, 18, 34, 13, k.cap) : '') +
      p('M56,50 C64,46 78,48 86,54 C82,60 72,62 62,60 C58,58 56,54 56,50 Z', k.cheek || CREAM) +
      p('M82,60 C90,60 95,58 98,55 L96,70 C92,78 86,82 82,80 C80,74 80,66 82,60 Z', k.bib || INK),
    eye: 'song',
  }),
  robin: (k, id) => ({
    beak: BEAKS.cone,
    defs: `<linearGradient id="${id}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${k.breast || AMBER}"/><stop offset=".6" stop-color="${k.breast || AMBER}"/><stop offset=".86" stop-color="${k.belly || CREAM}"/></linearGradient>`,
    chestFill: `url(#${id}r)`,
    marks: p(THROAT, k.face),
    eye: 'song',
  }),
  cardinal: (k) => ({
    beak: BEAKS.cone,
    chest: false,
    behind: p('M50,30 L44,0 L62,16 L70,-2 L82,24 Z', k.crest),
    marks: p('M70,38 C80,34 90,38 97,48 L97,58 C90,58 82,56 74,52 Z', k.mark),
    eye: 'song',
  }),
  jay: (k) => ({
    beak: BEAKS.cone,
    behind: p('M44,34 C36,14 50,0 70,2 C64,6 62,10 64,16 C70,14 76,16 80,22 L60,30 Z', k.crest),
    marks: p('M74,56 C82,56 90,58 98,56 L96,70 C90,76 80,76 74,68 Z', k.face) +
      `<path d="M47,110 C50,96 60,84 78,78 C86,76 92,80 96,88" fill="none" stroke="${k.mark}" stroke-width="4" stroke-linecap="round"/>`,
    eye: 'song',
  }),
  kingfisher: (k) => ({
    beak: BEAKS.dagger,
    behind: p('M44,28 L40,10 L52,22 L56,6 L64,20 L72,8 L76,22 Z', k.nape),
    marks: p(FRONT_THROAT, k.face),
    eye: 'song',
  }),
  hummingbird: (k) => ({
    sil: SIL_LOW,
    beak: BEAKS.needle,
    marks: k.gorget ? p('M72,60 C80,58 88,58 96,54 L94,68 C88,76 78,76 72,68 Z', k.gorget) : '',
    eye: 'song',
  }),
  owl: (k) => ({
    sil: SIL_OWL_FRONT,
    chestPath: 'M40,128 C42,104 52,90 64,88 C76,90 86,104 88,128 Z',
    beak: 'M60,56 L68,56 L64,62 Z',
    behind: p('M34,36 L28,10 L50,22 Z', k.crest) + p('M94,36 L100,10 L78,22 Z', k.crest),
    marks: circle(50, 52, 17, k.disc || CREAM) + circle(78, 52, 17, k.disc || CREAM) +
      p('M36,60 L64,79 L92,60 Z', k.disc || CREAM),
    eye: 'owlFront',
  }),
  osprey: (k) => ({
    beak: BEAKS.hook,
    behind: p(NAPE_SPIKES, k.nape),
    marks:
      p('M48,36 C60,30 84,30 97,46 L97,60 C90,72 72,76 54,66 Z', k.face) +
      p('M86,39.5 C72,41 54,44.5 32,50 C54,48.5 72,46.5 86,44.5 Z', k.stripe || INK),
    eye: 'amber',
  }),
  sparrowhawk: (k) => ({
    beak: BEAKS.hook,
    beakExtra: k.cere ? p('M93,40 H100 V66 H93 Z', k.cere) : '',
    behind: p(NAPE_SPIKES, k.nape),
    chestMarks: `<path d="M58,96 q7,-4 14,0 t14,0 t12,0 M56,106 q7,-4 14,0 t14,0 t14,0 M58,116 q7,-4 14,0 t14,0 t14,0" stroke="${k.bars || GREY}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    eye: 'raptor',
  }),
  eagle: (k) => ({
    beak: 'M94,44 C110,41 124,47 124,56 C124,63 119,67 116,65 C115,59 110,56 104,57 L94,60 Z',
    chest: false,
    marks: p('M0,0 H128 V86 L94,84 L88,90 L80,82 L72,88 L64,80 L56,86 L48,78 L40,82 L34,74 L0,72 Z', k.head || CREAM),
    eye: 'raptorHeavy',
  }),
  penguin: (k) => ({
    beak: BEAKS.straight,
    marks: p('M62,40 C70,30 86,34 94,48 C90,58 84,66 76,68 C66,66 60,54 62,40 Z', k.face),
    eye: 'dot',
  }),
  puffin: (k) => ({
    beak: 'M93,38 L126,52 L93,68 Z',
    beakExtra: p('M93,30 H102 V76 H93 Z', k.band || GREY) +
      (k.ridge ? p('M106,30 H108.5 V76 H106 Z', k.ridge) : ''),
    marks: p('M56,30 C70,24 88,28 95,44 L95,62 C88,70 70,72 56,62 Z', k.face),
    eye: 'dot',
  }),
  toucan: (k, id) => ({
    beak: 'M92,38 C112,34 128,46 126,62 C124,72 112,74 92,66 Z',
    defs: k.beak2 ? `<linearGradient id="${id}k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${k.beak}"/><stop offset="1" stop-color="${k.beak2}"/></linearGradient>` : '',
    beakFill: k.beak2 ? `url(#${id}k)` : k.beak,
    beakExtra: p('M116,30 H130 V80 H118 C122,66 120,48 116,30 Z', k.tip || INK),
    chest: false,
    marks: p('M58,34 C72,28 88,32 94,44 L94,64 C86,72 70,72 58,62 Z', k.face),
    eye: 'dot',
  }),
  heron: (k) => ({
    beak: BEAKS.dagger,
    behind: p('M46,30 C30,26 18,22 8,16 C22,18 36,24 50,26 Z', k.plume || INK),
    marks: p(THROAT, k.face) +
      (k.stripe ? p('M96,40 C84,38.5 64,39.5 44,42 L44,45 C64,42.5 84,42 96,43.5 Z', k.stripe) : ''),
    eye: 'song',
  }),
  blackbird: () => ({
    beak: 'M94,44 C108,42 120,48 121,54 L94,60 Z',
    chest: false,
    eye: 'song',
  }),
  cockatoo: (k) => ({
    beak: 'M95,44 C108,40 120,48 119,60 C118,68 112,72 108,68 C110,62 106,58 100,58 L95,60 Z',
    beakFill: k.color ? k.beak : '#4a4440',
    front: ['M53,26 C48,14 54,5 66,3 C61,9 60,16 62,24 Z', 'M62,23 C62,11 72,4 85,6 C77,10 73,16 72,23 Z', 'M71,24 C75,14 87,10 98,14 C90,16 84,21 81,28 Z'].map((d) => p(d, k.crestAccent || AMBER)).join(''),
    eye: 'dot',
  }),
};

function paletteByKey(key) {
  return PALETTES.find((x) => x.key === key) || PALETTES[0];
}

/* Options: tone, palette, size (px), radius (% of the side; 0 = square),
 * idPrefix (fixed ids for deterministic output), background (literal fill that
 * overrides the palette; palette '__BG__' emits the server template placeholder). */
export function birdSvg(speciesKey, opts = {}) {
  const { tone = 'color', palette = 'paper', size = 96, radius = 17, idPrefix, background } = opts;
  const id = idPrefix || `kb${++counter}`;
  const key = BUILD[speciesKey] ? speciesKey : 'sparrow';
  const k = resolveColors(key, tone);
  const b = BUILD[key](k, id);
  const sil = b.sil || SIL;
  const showChest = b.chest !== false && (!!k.chest || !!b.chestFill);
  const chestD = b.chestPath || CHEST;
  const bg = background || (palette === BG_PLACEHOLDER ? BG_PLACEHOLDER : paletteByKey(palette).bg);
  const r = (radius / 100) * 128;
  const beakD = b.beak;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" role="img" aria-label="${key}">`,
    '<defs>',
    `<linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${k.top}"/><stop offset="1" stop-color="${k.bottom}"/></linearGradient>`,
    `<clipPath id="${id}f"><rect width="128" height="128" rx="${r}"/></clipPath>`,
    `<clipPath id="${id}s"><path d="${sil}"/></clipPath>`,
    `<clipPath id="${id}c"><path d="${chestD}"/></clipPath>`,
    `<clipPath id="${id}b"><path d="${beakD}"/></clipPath>`,
    b.defs || '',
    '</defs>',
    `<rect width="128" height="128" rx="${r}" fill="${bg}"/>`,
    `<g clip-path="url(#${id}f)">`,
    b.behind || '',
    p(sil, `url(#${id}g)`),
    showChest ? `<g clip-path="url(#${id}s)">${p(chestD, b.chestFill || k.chest)}</g>` : '',
    b.chestMarks ? `<g clip-path="url(#${id}c)">${b.chestMarks}</g>` : '',
    b.marks ? `<g clip-path="url(#${id}s)">${b.marks}</g>` : '',
    p(beakD, b.beakFill || k.beak),
    b.beakExtra ? `<g clip-path="url(#${id}b)">${b.beakExtra}</g>` : '',
    b.front || '',
    eye(b.eye || 'song', k),
    '</g>',
    '</svg>',
  ].join('');
}

/* FNV-1a 32-bit over the UTF-8 bytes of the seed. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(str)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function seedToAvatar(seed) {
  const s = String(seed || '');
  const isPalette = (k) => PALETTES.some((x) => x.key === k);
  const full = /^bird-([a-z]+)-(color|slate|ink)-([a-z]+)$/.exec(s);
  if (full && BUILD[full[1]] && isPalette(full[3])) {
    return { species: full[1], tone: full[2], palette: full[3] };
  }
  const short = /^bird-([a-z]+)-([a-z]+)$/.exec(s);
  if (short && BUILD[short[1]] && isPalette(short[2])) {
    return { species: short[1], tone: 'color', palette: short[2] };
  }
  const h = hash(s);
  return {
    species: SPECIES[h % SPECIES.length].key,
    tone: 'color',
    palette: PALETTES[(h >>> 8) % PALETTES.length].key,
  };
}

/* Tinted roster: every bird gets a non-white palette from its position. */
export function tintForSpecies(key) {
  const i = SPECIES.findIndex((x) => x.key === key);
  return PALETTES[1 + (Math.max(i, 0) % (PALETTES.length - 1))].key;
}

export const TONES = ['color', 'slate', 'ink'];
