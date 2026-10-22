// Screen menu, URL state, theme and boot.
import { $, esc, timers, ic, S, resetState, ios } from './core.js';
import { renderIOS, instantOn } from './cards.js';
import { openRoom, openNew, openDetail } from './ios.js';
import { openCreate, createSubmit } from './rooms.js';
import { MAC_W, MAC_H, renderMac } from './mac.js';

// ---------- screens ----------
export const PICKS_IOS = [
  ['Wallet', [['wallet', 'Home wallet'], ['fanned', 'Wallet fanned out'], ['detail', 'Card detail']]],
  ['Pair code', [['room', 'Join with a code'], ['create', 'Create a code'], ['code', 'New code']]],
  ['Create', [['new', 'New card'], ['empty', 'Empty wallet, first run']]],
  ['States', [['kaust', 'Custom card named KAUST']]],
];
export const MAC_SCREENS = [['wallet', 'Home'], ['detail', 'Card page with references'], ['room', 'Join with a code'], ['create', 'Create a code'], ['code', 'New code'], ['new', 'New card'], ['empty', 'Empty, first run'], ['kaust', 'Custom card named KAUST']];
export const PICKS_MAC = [['Mac', MAC_SCREENS]];
export const PRESET = {
  wallet: () => {},
  fanned: () => { S.fanned = true; },
  detail: () => { if (!ios()) { S.sub = 'work'; return null; } return () => openDetail('work', { instant: true }); },
  create: () => () => openCreate('work', { instant: true }),
  code: () => () => { openCreate('work', { instant: true, name: 'Agents meetup' }); createSubmit(); ($('#cfBody') || $('#mpop'))?.classList.remove('swapin'); },
  room: () => { S.code = '4821'; if (!ios()) { S.pending = 'poster26'; return null; } return () => openRoom('poster26'); },
  new: () => () => openNew({ instant: true }),
  empty: () => { S.cards = []; S.suggest = true; S.active = 'suggest'; },
  kaust: () => { S.active = 'kaust'; },
};
export function currentKey() {
  if (S.sheet) {
    if (S.sheet.type === 'detail') return 'detail';
    if (S.sheet.type === 'new') return 'new';
    if (S.sheet.type === 'choose') return 'room';
    if (S.sheet.type === 'create') return S.sheet.step === 'done' ? 'code' : 'create';
  }
  if (!ios() && S.sub) return 'detail';
  if (!ios() && S.pending) return 'room';
  if (S.lastJump && ['wallet', 'fanned', 'empty', 'kaust'].includes(S.lastJump)) {
    const same = { wallet: !S.fanned, fanned: S.fanned, empty: S.suggest, kaust: S.active === 'kaust' && !S.fanned };
    if (same[S.lastJump]) return S.lastJump;
  }
  if (S.suggest && !S.cards.length) return 'empty';
  if (S.fanned) return 'fanned';
  return S.active === 'kaust' ? 'kaust' : 'wallet';
}
export function jump(key) {
  if (key.includes(':')) key = key.split(':').pop();
  if (key === 'choose') key = 'room';
  if (S && S.mode === 'mac' && key === 'fanned') key = 'wallet';
  timers.forEach(clearTimeout); timers.length = 0;
  resetState(S.mode || 'ios');
  const after = PRESET[key] ? PRESET[key]() : null;
  S.lastJump = key;
  render();
  if (typeof after === 'function') after();
  if (key === 'room' && ios()) { instantOn(); }
  syncPick(); syncURL();
}
export function render() { if (ios()) renderIOS(); else renderMac(); }
export function fillPick() {
  const picks = S && S.mode === 'mac' ? PICKS_MAC : PICKS_IOS;
  $('#pick').innerHTML = '<option value="" disabled>Screen</option>' + picks.map(([g, opts]) => `<optgroup label="${esc(g)}">${opts.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
}
export function syncPick() { $('#pick').value = currentKey(); }
export function isDark() { return document.documentElement.dataset.theme === 'dark'; }
export function syncURL() {
  if (!S) return;
  syncPick();
  const q = new URLSearchParams({ screen: currentKey(), mode: S.mode });
  q.set('theme', isDark() ? 'dark' : 'light');
  try { history.replaceState(null, '', '?' + q.toString()); } catch { /* file URLs */ }
}
export const HINTS = {
  ios: 'Tap the stack to fan the cards out, then tap a card to share it. The more button on the front card flips it.',
  mac: 'Click a card to share it. Open on the selected card shows its page.',
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
  if (!S.mode) resetState(mode);
  S.mode = mode;
  $('#modeIos').setAttribute('aria-pressed', mode === 'ios'); $('#modeMac').setAttribute('aria-pressed', mode === 'mac');
  $('#phone').hidden = mode !== 'ios';
  if (mode === 'ios') $('#mac').innerHTML = ''; else $('#screen').innerHTML = '';
  $('#hint').textContent = HINTS[mode];
  fillPick(); fitMac();
  jump(key || currentKey());
}
export function paintThemeBtn() { $('#themeBtn').innerHTML = ic(isDark() ? 'sun' : 'moon'); $('#themeBtn').title = isDark() ? 'Light' : 'Dark'; }

// ---------- boot ----------
export const params = new URLSearchParams(location.search);
export const theme = params.get('theme');
document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#themeBtn').addEventListener('click', () => { document.documentElement.dataset.theme = isDark() ? 'light' : 'dark'; paintThemeBtn(); syncURL(); });
$('#modeIos').addEventListener('click', () => { if (S.mode !== 'ios') setMode('ios'); });
$('#modeMac').addEventListener('click', () => { if (S.mode !== 'mac') setMode('mac'); });
$('#pick').addEventListener('change', (e) => { if (e.target.value) jump(e.target.value); });
window.addEventListener('resize', fitMac);
paintThemeBtn();
export const startKey = PRESET[params.get('screen')] ? params.get('screen') : 'wallet';
setMode(params.get('mode') === 'mac' ? 'mac' : 'ios', startKey);
