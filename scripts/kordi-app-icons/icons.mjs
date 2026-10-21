// Source of truth for the Kordi paper-cut bird app icon and its alternate colors.
// `generate.mjs` renders these SVGs into the iOS asset catalog and the desktop icons.

export const AMBER = '#f7b32b';
export const INK = '#1f1a17';
export const CREAM = '#f4ede1';

// Alternate icons offered in the in-app picker. `white` is the primary icon.
// Keys are stable identifiers shared by iOS, desktop, and persisted preferences.
export const APP_ICON_VARIANTS = [
  { key: 'white', name: 'White', bg: '#ffffff' },
  { key: 'frosted', name: 'Frosted Glass', bg: '#f3f1ee', frosted: true },
  { key: 'rice', name: 'Rice Paper', bg: '#fbf5ea' },
  { key: 'coral', name: 'Coral', bg: '#ff8a6b' },
  { key: 'sakura', name: 'Sakura', bg: '#f9c6d3' },
  { key: 'butter', name: 'Butter', bg: '#ffd96a', beak: '#f08a24' },
  { key: 'mint', name: 'Mint', bg: '#bfe6cf' },
  { key: 'sky', name: 'Sky', bg: '#a9d8f2' },
  { key: 'lavender', name: 'Lavender', bg: '#d6cdf3' },
  { key: 'night', name: 'Night', bg: '#2a2420', bird: CREAM },
  { key: 'midnight', name: 'Midnight', bg: '#1c2a44', bird: CREAM },
  { key: 'forest', name: 'Forest', bg: '#1f3a30', bird: CREAM },
  { key: 'plum', name: 'Plum', bg: '#3a2240', bird: CREAM },
  { key: 'cocoa', name: 'Cocoa', bg: '#4a3226', bird: CREAM },
  { key: 'slate', name: 'Slate', bg: '#3b4250', bird: CREAM },
  { key: 'night-sakura', name: 'Night Sakura', bg: '#2a2420', bird: '#f9c6d3' },
  { key: 'midnight-sky', name: 'Midnight Sky', bg: '#1c2a44', bird: '#a9d8f2' },
];

// Gray development and Beta icon, so non-production builds stay distinguishable.
export const DEVELOPMENT_VARIANT = { key: 'development', bg: '#d1d1d6', bird: '#6e6e73', beak: '#a1a1a6' };

// Bird geometry in a 512 x 512 box, optically centered.
const PLACE = 'translate(256,250) scale(0.94) translate(-270,-292)';
const BODY = '<ellipse cx="262" cy="292" rx="150" ry="136"/>';
const TAIL = '<path d="M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z" stroke-width="4" stroke-linejoin="round"/>';
const EYE = '<circle cx="194" cy="266" r="17"/>';
const WING =
  '<path transform="translate(332,322) scale(0.8) translate(-326,-312)" d="M248,326 C276,284 346,262 408,266 C388,316 332,356 272,354 C252,352 242,340 248,326Z"/>';
const BEAK = '<path d="M120,276 L82,294 L120,312Z" stroke-width="12" stroke-linejoin="round"/>';

function paperFilter(id) {
  return `<filter id="${id}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="3.6" result="b"/>
    <feOffset in="b" dy="4" result="o"/>
    <feFlood flood-color="#5a3412" flood-opacity="0.26"/>
    <feComposite in2="o" operator="in" result="s"/>
    <feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}

// The bird alone. The eye and wing are cut through, so the background shows through them.
export function birdMarkup({ bird = INK, beak = AMBER, shadow = true } = {}) {
  const filter = shadow ? ' filter="url(#paper)"' : '';
  return `<defs>${shadow ? paperFilter('paper') : ''}
    <mask id="cut" maskUnits="userSpaceOnUse" x="-100" y="-100" width="712" height="712">
      <g fill="#fff" stroke="#fff">${BODY}${TAIL}</g>
      <g fill="#000">${EYE}${WING}</g>
    </mask>
  </defs>
  <g transform="${PLACE}">
    <g${filter} fill="${beak}" stroke="${beak}">${BEAK}</g>
    <g${filter}><rect x="-100" y="-100" width="712" height="712" fill="${bird}" mask="url(#cut)"/></g>
  </g>`;
}

function frostedBackground() {
  return `<defs>
    <filter id="frost" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>
    <linearGradient id="sheen" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#f3f1ee"/>
  <g filter="url(#frost)">
    <circle cx="110" cy="120" r="120" fill="#ffb38a"/>
    <circle cx="420" cy="150" r="120" fill="#8fd3ff"/>
    <circle cx="300" cy="440" r="130" fill="#c6a8ff"/>
  </g>
  <rect width="512" height="512" fill="url(#sheen)"/>`;
}

// Full-bleed square icon (iOS masks the corners itself).
export function squareIconSvg(variant, size = 1024) {
  const background = variant.frosted
    ? frostedBackground()
    : variant.bg
      ? `<rect width="512" height="512" fill="${variant.bg}"/>`
      : '';
  const bird = birdMarkup({ bird: variant.bird ?? INK, beak: variant.beak ?? AMBER });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${background}${bird}</svg>`;
}

// macOS icon: rounded tile on the 824/1024 grid with a soft drop shadow.
export function macIconSvg(variant, size = 1024) {
  const inner = squareIconSvg(variant, 512).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <filter id="tileShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
      <feOffset dy="10"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${variant.bg ?? '#ffffff'}" filter="url(#tileShadow)"/>
  <g clip-path="url(#tile)">
    <svg x="100" y="100" width="824" height="824" viewBox="0 0 512 512">${inner}</svg>
  </g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#000" stroke-opacity="0.08"/>
</svg>`;
}

// Launch screen mark: flat bird with the eye and wing cut through, no shadow.
export function launchMarkSvg({ bird = INK, size = 58 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${birdMarkup({ bird, shadow: false })}</svg>\n`;
}

// Compact single-file mark for favicons and server-rendered pages. Uses single
// quotes so it can be embedded in Rust strings and data URLs.
export function inlineMarkSvg({ color = 'currentColor', beak = color } = {}) {
  return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='64 58 384 384' aria-hidden='true'>"
    + "<mask id='kordi-bird-cut' maskUnits='userSpaceOnUse' x='-100' y='-100' width='712' height='712'>"
    + "<ellipse cx='262' cy='292' rx='150' ry='136' fill='#fff'/>"
    + "<path d='M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z' fill='#fff' stroke='#fff' stroke-width='4' stroke-linejoin='round'/>"
    + "<circle cx='194' cy='266' r='17'/>"
    + "<path d='M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z'/>"
    + "</mask><g transform='translate(256,250) scale(0.94) translate(-270,-292)'>"
    + `<path d='M120,276 L82,294 L120,312Z' fill='${beak}' stroke='${beak}' stroke-width='12' stroke-linejoin='round'/>`
    + `<rect x='-100' y='-100' width='712' height='712' fill='${color}' mask='url(#kordi-bird-cut)'/>`
    + '</g></svg>';
}

export function inlineMarkDataUrl() {
  const svg = inlineMarkSvg({ color: INK, beak: AMBER }).replace(" aria-hidden='true'", '');
  return `data:image/svg+xml,${svg.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}`;
}

// Kordi Support avatar: the ink bird on white.
export function supportAvatarSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#ffffff"/>
  <g transform="translate(36,36) scale(0.86)">${birdMarkup({ shadow: false })}</g>
</svg>
`;
}

// System notice avatar: the development-gray bird on a light gray disc, flat so it
// stays crisp at 28px and reads the same in light and dark mode.
export function systemAvatarSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="System">
  <circle cx="256" cy="256" r="256" fill="#e5e5ea"/>
  <g transform="translate(56,56) scale(0.78)">${birdMarkup({ bird: DEVELOPMENT_VARIANT.bird, beak: DEVELOPMENT_VARIANT.beak, shadow: false })}</g>
</svg>
`;
}

// README title: the bird and the wordmark on one optical centre line, the tagline
// centred beneath. HTML so the browser measures the text; SF Pro Rounded matches
// the bird's soft shapes (system font on macOS, where the generator runs).
export function readmeTitleHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Kordi Rounded'; src: url('file:///System/Library/Fonts/SFNSRounded.ttf'); font-weight: 1 1000; }
  html, body { margin: 0; width: 1774px; height: 470px; background: #ffffff; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 44px; padding-bottom: 50px; box-sizing: border-box;
    font-family: 'Kordi Rounded', ui-rounded, system-ui, sans-serif; color: ${INK}; }
  .lockup { display: flex; align-items: center; gap: 40px; transform: translateX(-16px); }
  .bird { width: 400px; height: 400px; margin: -40px 0 -40px -24px; transform: translateY(2px); }
  .word { font-size: 270px; font-weight: 700; letter-spacing: -0.035em; line-height: 1; transform: translateY(-14px); }
  .tagline { font-size: 52px; font-weight: 500; letter-spacing: 0.005em; color: #6b625b; }
</style></head><body>
  <div class="lockup">
    <svg class="bird" viewBox="0 0 512 512">${birdMarkup()}</svg>
    <div class="word">kordi</div>
  </div>
  <div class="tagline">Building AI-Native Supercollaboration</div>
</body></html>
`;
}

// Flat silhouette for favicons and the macOS menu bar template image.
// `crop` trims the padding so the bird fills small canvases.
export function silhouetteSvg({ color = INK, size = 512, crop = false } = {}) {
  const viewBox = crop ? '64 58 384 384' : '0 0 512 512';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${birdMarkup({ bird: color, beak: color, shadow: false })}</svg>`;
}
