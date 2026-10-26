// Shared helpers, outline icons and the one state object.
import { NEEDS, CARDS } from './data.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
export const DUR = () => (reduced.matches ? 0 : 260);
export const timers = [];
export const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };

// ---------- icons (outline, 24 px grid) ----------
export const I = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  updown: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></g>',
  hash: '<path d="M10 4L8 20M16 4l-2 16M4.5 9h15M4 15h15"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>',
  tap: '<rect x="8" y="3.5" width="8" height="17" rx="2"/><path d="M11 17.5h2M4.6 8.5a5 5 0 0 0 0 7M2.2 6.3a8.4 8.4 0 0 0 0 11.4M19.4 8.5a5 5 0 0 1 0 7M21.8 6.3a8.4 8.4 0 0 1 0 11.4"/>',
  phones: '<rect x="2.8" y="3" width="7.5" height="16.5" rx="1.9"/><rect x="13.7" y="4.5" width="7.5" height="16.5" rx="1.9"/><path d="M5.6 16.5h1.9M16.5 18h1.9"/>',
  userPlus: '<circle cx="10" cy="8" r="3.6"/><path d="M3.5 20c.6-3.6 3.2-5.8 6.5-5.8s5.9 2.2 6.5 5.8M18.5 8v6M15.5 11h6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  message: '<path d="M4.5 5.5h15v10.5h-9L6 19.5V16H4.5z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  sparkle: '<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  cg: '<circle cx="7.6" cy="10" r="2.6"/><circle cx="16.4" cy="10" r="2.6"/><path d="M2.6 21.2c0-3.6 2.3-5.9 5.2-5.9 1.7 0 3 .6 4.2 1.8 1.2-1.2 2.5-1.8 4.2-1.8 2.9 0 5.2 2.3 5.2 5.9"/><path d="M7.6 18.6c1.2 1.1 2.7 1.7 4.4 1.7s3.2-.6 4.4-1.7"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c.6-3 3-5 6-5s5.4 2 6 5M15 14.5c2.6 0 4.6 1.6 5.2 4.5"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  flash: '<path d="M8 3h8v3l-2 3.5V20a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V9.5L8 6z"/><path d="M8 6h8"/><circle cx="12" cy="13.5" r=".9" fill="currentColor"/>',
  camera: '<path d="M4 8h3.5L9 5.5h6L16.5 8H20v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>',
  seal: '<path d="M12 3l2.2 1.6 2.7-.1.8 2.6 2.2 1.6-.9 2.6.9 2.6-2.2 1.6-.8 2.6-2.7-.1L12 21l-2.2-1.6-2.7.1-.8-2.6-2.2-1.6.9-2.6-.9-2.6 2.2-1.6.8-2.6 2.7.1z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.2c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.2 0-2.2-.5-2.7-1.5M12 6.3v1.5M12 16.2v1.5"/>',
  // card glyphs (same as the profile cards preview)
  work: '<rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17"/>',
  research: '<path d="M3.5 9.5L12 4.5l8.5 5"/><path d="M5.5 10.5v6.5M9.8 10.5v6.5M14.2 10.5v6.5M18.5 10.5v6.5M3.5 19.5h17"/>',
  health: '<path d="M5.5 18.5C5.5 10.5 10.5 5.5 19 5c0 8.5-5 13.5-13.5 13.5z"/><path d="M5.5 18.5c2.8-3.8 5.6-6.4 8.6-8.4"/>',
  workshop: '<path d="M8 3l4 6 4-6"/><rect x="6" y="9" width="12" height="12" rx="2.5"/><circle cx="12" cy="13.6" r="1.7"/><path d="M9.5 17.6h5"/>',
};
export const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[name] || I.sparkle}</svg>`;
export const bird = (cls = 'gc-mark') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#kbird" width="24" height="24"/></svg>`;
export const spinner = () => '<i class="spin" aria-hidden="true"></i>';

// ---------- state ----------
export const S = {};
export function freshState(mode) {
  return {
    mode,
    key: 'home',
    clock: '3:41',
    nb: {
      on: true, paused: null, card: 'work', openTo: ['Coffee chat'], range: 2000, min: 0,
      alerts: { requests: true, matches: true, max: 3 },
      access: 'always', fresh: true, empty: false, phone: true,
    },
    needs: clone(NEEDS),
    added: {},
    tab: 'shared',
    person: 'maya',
    consent: { card: 'work', background: true },
    layer: null,
    draft: null,
  };
}
export function resetState(mode) { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, freshState(mode)); }
export const ios = () => S.mode === 'ios';
export const cardById = (id) => CARDS.find((c) => c.id === id) || CARDS[0];
