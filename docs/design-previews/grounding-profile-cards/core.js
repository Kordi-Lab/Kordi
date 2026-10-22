// Shared helpers, icons and the one state object.
import { KINDS, SEED, ROOMS } from './data.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
export const DUR = () => (reduced.matches ? 0 : 300);
export const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
export const timers = [];

// ---------- icons ----------
export const I = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  flip: '<g fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></g>',
  hash: '<path d="M10 4L8 20M16 4l-2 16M4.5 9h15M4 15h15"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h2M20 14v2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  cg: '<circle cx="7.6" cy="10" r="2.6"/><circle cx="16.4" cy="10" r="2.6"/><path d="M2.6 21.2c0-3.6 2.3-5.9 5.2-5.9 1.7 0 3 .6 4.2 1.8 1.2-1.2 2.5-1.8 4.2-1.8 2.9 0 5.2 2.3 5.2 5.9"/><path d="M7.6 18.6c1.2 1.1 2.7 1.7 4.4 1.7s3.2-.6 4.4-1.7"/>',
  message: '<path d="M4.5 5.5h15v10.5h-9L6 19.5V16H4.5z"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c.6-3 3-5 6-5s5.4 2 6 5M15 14.5c2.6 0 4.6 1.6 5.2 4.5"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  share: '<path d="M12 15V3.5M8 7.5l4-4 4 4"/><path d="M7 11H5v9h14v-9h-2"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.3-.5 4.6-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  memory: '<path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-1 5.8V15a3 3 0 0 0 3 3h1m6-14a3 3 0 0 1 3 3v1a3 3 0 0 1 1 5.8V15a3 3 0 0 1-3 3h-1M12 4v16"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  paper: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  note: '<path d="M5 4h14v16H5z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  sparkle: '<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  // card glyphs
  work: '<rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17"/>',
  research: '<path d="M3.5 9.5L12 4.5l8.5 5"/><path d="M5.5 10.5v6.5M9.8 10.5v6.5M14.2 10.5v6.5M18.5 10.5v6.5M3.5 19.5h17"/>',
  health: '<path d="M5.5 18.5C5.5 10.5 10.5 5.5 19 5c0 8.5-5 13.5-13.5 13.5z"/><path d="M5.5 18.5c2.8-3.8 5.6-6.4 8.6-8.4"/>',
  daily: '<rect x="4.5" y="4" width="15" height="16.5" rx="2.5"/><path d="M8 9.5l1.5 1.5 3-3M8 15.5l1.5 1.5 3-3M14.5 10h2M14.5 16h2"/>',
  workshop: '<path d="M8 3l4 6 4-6"/><rect x="6" y="9" width="12" height="12" rx="2.5"/><circle cx="12" cy="13.6" r="1.7"/><path d="M9.5 17.6h5"/>',
  custom: '<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
};
export const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[name] || I.sparkle}</svg>`;
export const bird = () => '<svg class="gc-mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#kbird" width="24" height="24"/></svg>';

// ---------- state ----------
export const S = {};
export function resetState(mode) { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, freshState(mode)); }
export function freshState(mode) {
  return { mode, cards: SEED(), active: 'work', fanned: false, suggest: false, building: null, rooms: ROOMS(), sheet: null, confirm: null, lastJump: null, renaming: false };
}
export const cardById = (id) => S.cards.find((c) => c.id === id);
export const activeCard = () => cardById(S.active) || S.cards[0] || null;
export const takenKinds = () => S.cards.map((c) => c.kind).filter((k) => KINDS[k].fixed);
export function walletList() {
  if (S.suggest && !S.cards.length) return [{ id: 'suggest', kind: 'work', name: 'Work', focus: '', topics: [], hidden: [], sources: [], suggested: true }];
  return S.cards;
}
export const ios = () => S.mode === 'ios';
export const geo = () => (ios() ? { cw: 338, ch: 213, peek: 12, strip: 54, plusH: 56 } : { cw: 372, ch: 235, peek: 12, strip: 56, plusH: 56 });
