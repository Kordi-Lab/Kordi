// Screen menu, presets, URL state, theme and boot.
import { $, esc, timers, ic, S, resetState, ios } from './core.js';
import { draftFor } from './ios-layers.js';
import { renderIOS } from './ios.js';
import { MAC_W, MAC_H, renderMac } from './mac.js';

export const PICKS_IOS = [
  ['Home', [['home', 'Home'], ['home-off', 'Home, Nearby off'], ['home-paused', 'Home, Nearby paused']]],
  ['Turn on', [['off', 'Nearby off'], ['consent', 'Turn on Nearby?']]],
  ['Nearby', [['on', 'Nearby on'], ['range', 'Range menu'], ['score', 'Match menu'], ['menu', 'Pause menu'], ['empty', 'No one nearby yet']]],
  ['Requests', [['request', 'New request'], ['request-edit', 'Edit request']]],
  ['Person', [['person', 'Nearby person']]],
  ['Alerts', [['alert', 'Request alert'], ['alert-match', 'Match alert']]],
  ['Location', [['limited', 'Only while Kordi is open'], ['denied', 'Location access off'], ['stale', 'Location out of date'], ['paused', 'Paused']]],
];
export const PICKS_MAC = [
  ['Home', [['home', 'Home'], ['home-off', 'Home, Nearby off']]],
  ['Nearby', [['on', 'Nearby'], ['range', 'Range menu'], ['score', 'Match menu'], ['menu', 'Pause menu'], ['paused', 'Paused'], ['no-phone', 'No iPhone location'], ['off', 'Nearby off']]],
  ['Dialogs', [['consent', 'Turn on Nearby?'], ['request', 'New request'], ['request-edit', 'Edit request']]],
  ['Person', [['person', 'Nearby person']]],
];
const keysOf = (picks) => picks.flatMap(([, opts]) => opts.map(([k]) => k));

const FILLED = { text: 'Coffee with a Fudan or SJTU alum', range: 1000, window: { from: '3:00 PM', until: '6:00 PM' }, paused: false };
const menuAt = (menu) => ({ type: 'menu', menu, anchor: ios() ? { range: '#rangePill', score: '#scorePill', more: '#navMore' }[menu] : { range: '#mRange', score: '#mScore', more: '#mMore' }[menu] });
export const PRESET = {
  home: () => { S.page = 'home'; },
  'home-off': () => { S.nb.on = false; S.page = 'home'; },
  'home-paused': () => { S.nb.paused = '3:00 PM'; S.clock = '1:12'; S.page = 'home'; },
  off: () => { S.nb.on = false; S.page = 'off'; },
  consent: () => { S.nb.on = false; S.page = 'off'; S.layer = { type: 'consent' }; },
  on: () => { S.page = 'nearby'; },
  range: () => { S.page = 'nearby'; S.layer = menuAt('range'); },
  score: () => { S.page = 'nearby'; S.layer = menuAt('score'); },
  menu: () => { S.page = 'nearby'; S.layer = menuAt('more'); },
  empty: () => { S.nb.empty = true; S.page = 'nearby'; },
  request: () => { S.page = 'nearby'; S.layer = { type: 'request', id: null, draft: JSON.parse(JSON.stringify(FILLED)) }; },
  'request-edit': () => { S.page = 'nearby'; S.layer = { type: 'request', id: 'n2', draft: draftFor('n2') }; },
  person: () => { S.page = 'person'; S.person = 'maya'; },
  alert: () => { S.page = 'lock'; S.alert = 'need'; },
  'alert-match': () => { S.page = 'lock'; S.alert = 'match'; },
  limited: () => { S.nb.access = 'limited'; S.page = 'nearby'; },
  denied: () => { S.nb.access = 'denied'; S.page = 'nearby'; },
  stale: () => { S.nb.fresh = false; S.page = 'nearby'; },
  paused: () => { S.nb.paused = '3:00 PM'; S.clock = '1:12'; S.page = 'nearby'; },
  'no-phone': () => { S.nb.phone = false; S.page = 'nearby'; },
};
export function currentKey() {
  const nb = S.nb; const L = S.layer;
  if (S.page === 'lock') return S.alert === 'match' ? 'alert-match' : 'alert';
  if (S.page === 'person') return 'person';
  if (S.page === 'home') return !nb.on ? 'home-off' : nb.paused && ios() ? 'home-paused' : 'home';
  if (S.page === 'off') return L && L.type === 'consent' ? 'consent' : 'off';
  if (L && L.type === 'menu' && ['range', 'score', 'more'].includes(L.menu)) return L.menu === 'more' ? 'menu' : L.menu;
  if (L && L.type === 'request') return L.id ? 'request-edit' : 'request';
  if (nb.paused) return 'paused';
  if (!ios() && !nb.phone) return 'no-phone';
  if (ios() && nb.access === 'denied') return 'denied';
  if (!nb.fresh && ios()) return 'stale';
  if (ios() && nb.access === 'limited') return 'limited';
  if (nb.empty && ios()) return 'empty';
  return 'on';
}
export function jump(key) {
  const picks = ios() ? PICKS_IOS : PICKS_MAC;
  if (!keysOf(picks).includes(key)) key = 'home';
  timers.forEach(clearTimeout); timers.length = 0;
  resetState(S.mode || 'ios');
  PRESET[key]();
  render();
  syncURL();
}
export function render() { if (ios()) renderIOS(); else renderMac(); }
export function fillPick() {
  const picks = ios() ? PICKS_IOS : PICKS_MAC;
  $('#pick').innerHTML = '<option value="" disabled>Screen</option>' + picks.map(([g, opts]) => `<optgroup label="${esc(g)}">${opts.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
}
export function isDark() { return document.documentElement.dataset.theme === 'dark'; }
export function syncURL() {
  if (!S.mode) return;
  const key = currentKey();
  $('#pick').value = key;
  const q = new URLSearchParams({ screen: key, mode: S.mode, theme: isDark() ? 'dark' : 'light', icons: document.documentElement.dataset.icons });
  try { history.replaceState(null, '', '?' + q.toString()); } catch { /* file URLs */ }
}
const HINTS = {
  ios: 'Filters, chips, toggles and requests work. Tap a person or the alert.',
  mac: 'The Mac reads the location your iPhone sends. Filters, toggles and dialogs work.',
};
export function fitMac() {
  const narrow = window.innerWidth < 640; const mac = S.mode === 'mac';
  $('#macwrap').hidden = !mac || narrow; $('#macnote').hidden = !mac || !narrow;
  if (!mac || narrow) return;
  const k = Math.min(1, (window.innerWidth - 32) / MAC_W);
  $('#mac').style.transform = `scale(${k})`;
  $('#macwrap').style.width = Math.round(MAC_W * k) + 'px'; $('#macwrap').style.height = Math.round(MAC_H * k) + 'px';
}
export function setMode(mode, key) {
  const prev = S.mode ? currentKey() : null;
  if (!S.mode) resetState(mode);
  S.mode = mode;
  $('#modeIos').setAttribute('aria-pressed', String(mode === 'ios')); $('#modeMac').setAttribute('aria-pressed', String(mode === 'mac'));
  $('#phone').hidden = mode !== 'ios';
  if (mode === 'ios') $('#mac').innerHTML = ''; else $('#screen').innerHTML = '';
  $('#hint').textContent = HINTS[mode];
  fillPick(); fitMac();
  jump(key || prev || 'home');
}
export function paintThemeBtn() { $('#themeBtn').innerHTML = ic(isDark() ? 'sun' : 'moon'); $('#themeBtn').title = isDark() ? 'Light' : 'Dark'; }

// ---------- boot ----------
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#themeBtn').addEventListener('click', () => { document.documentElement.dataset.theme = isDark() ? 'light' : 'dark'; paintThemeBtn(); syncURL(); });
$('#modeIos').addEventListener('click', () => { if (S.mode !== 'ios') setMode('ios'); });
$('#modeMac').addEventListener('click', () => { if (S.mode !== 'mac') setMode('mac'); });
$('#pick').addEventListener('change', (e) => { if (e.target.value) jump(e.target.value); });
window.addEventListener('resize', fitMac);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.layer) { S.layer = null; render(); syncURL(); } });
// Icon style: today's look, tint (default), gradient or plain.
const ICONS = ['current', 'tint', 'gradient', 'plain'];
function setIcons(style) {
  document.documentElement.dataset.icons = style;
  document.querySelectorAll('#iconModes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.icons === style)));
}
setIcons(ICONS.includes(params.get('icons')) ? params.get('icons') : 'tint');
document.querySelectorAll('#iconModes button').forEach((b) => b.addEventListener('click', () => { setIcons(b.dataset.icons); syncURL(); }));
paintThemeBtn();
setMode(params.get('mode') === 'mac' ? 'mac' : 'ios', params.get('screen') || 'home');
