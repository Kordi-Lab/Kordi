// Pair code: join a room by its four digits, or create a meetup (both modes).
import { $, $$, esc, reduced, ic, S, cardById, ios } from './core.js';
import { NEW_CODE } from './data.js';
import { layoutWallet, closeLayer, showLayer, instantOn, toast } from './cards.js';
import { renderBelow, openRoom, chooseList } from './ios.js';
import { macRefresh, createMac, paintCreateMac } from './mac.js';
import { syncURL } from './app.js';

// ---------- pair code: join a room by its four digits, or create a meetup ----------
export function listedRooms() { return S.rooms.filter((r) => r.listed !== false); }
export function joinRoom(r, c) {
  r.sharing = c.id; r.listed = true;
  S.rooms = [r].concat(S.rooms.filter((x) => x !== r));
  S.code = ''; S.pending = null; S.codeErr = '';
}
export function digitsHTML(disabled) {
  const v = (S.code || '').split('');
  return `<span class="digits" role="group" aria-label="Pair code">${[0, 1, 2, 3].map((i) => `<input class="dig" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="Digit ${i + 1}" value="${esc(v[i] || '')}" ${disabled ? 'disabled' : ''}>`).join('')}</span>`;
}
export function bindDigits(box) {
  const ins = $$('.dig', box);
  ins.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(-1);
      S.code = ins.map((x) => x.value).join('');
      if (inp.value && ins[i + 1]) ins[i + 1].focus();
      if (ins.every((x) => x.value)) submitCode(S.code);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && ins[i - 1]) ins[i - 1].focus(); });
  });
}
export function submitCode(code) {
  const r = S.rooms.find((x) => x.code === code);
  S.lastJump = null;
  if (!r || !r.open) { S.code = ''; S.pending = null; S.codeErr = 'Room not found'; renderBelow(); syncURL(); return; }
  if (r.sharing) { S.code = ''; S.pending = null; S.codeErr = ''; renderBelow(); toast(`Already in ${r.name}`); syncURL(); return; }
  S.codeErr = '';
  if (ios()) { openRoom(r.id); return; }
  S.pending = r.id; macRefresh(); syncURL();
}
export function openCreate(cardId, opts = {}) {
  const list = chooseList(); if (!list.length) return;
  if (!list.some((c) => c.id === cardId)) cardId = list[0].id;
  S.fanned = false; layoutWallet();
  S.sheet = { type: 'create', step: 'form', name: opts.name || '', card: cardId, code: NEW_CODE, anchor: opts.anchor || null };
  if (ios()) createIOS(); else createMac();
  if (opts.instant) instantOn();
  syncURL();
}
export function createFormHTML() {
  const sh = S.sheet; const c = cardById(sh.card);
  return `<div class="cf-label">Share</div>
    <div class="cf-cards" role="radiogroup" aria-label="Card">${chooseList().map((x) => `<button class="cf-sw${x.id === sh.card ? ' on' : ''}" data-kind="${x.kind}" data-card="${esc(x.id)}" role="radio" aria-checked="${x.id === sh.card}" aria-label="${esc(x.name)}" title="${esc(x.name)}">${ic(x.kind)}</button>`).join('')}<span class="cf-pick">${esc(c.name)}</span></div>`;
}
export function createDoneHTML() {
  const sh = S.sheet; const c = cardById(sh.card);
  return `<div class="cd-code" aria-label="Code ${sh.code.split('').join(' ')}">${sh.code.split('').map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cd-name">${esc(sh.name)}</div><div class="cd-sub"><span class="mini" data-kind="${c.kind}"></span>Sharing ${esc(c.name)}</div>`;
}
export function createSubmit() {
  const sh = S.sheet; if (!sh || !sh.name.trim()) return;
  const c = cardById(sh.card);
  const room = { id: 'm' + sh.code, code: sh.code, name: sh.name.trim(), kind: c.kind, people: 1, open: true, sharing: c.id, mine: true, listed: true };
  S.rooms = [room].concat(S.rooms.filter((x) => x.code !== sh.code));
  sh.name = room.name; sh.step = 'done';
  renderBelow();
  if (ios()) paintCreateIOS(true); else paintCreateMac(true);
  syncURL();
}
export function bindCreate(l) {
  l.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-card]');
    if (sw) { S.sheet.card = sw.dataset.card; if (ios()) paintCreateIOS(); else paintCreateMac(); return; }
    if (e.target.closest('#cfGo')) { createSubmit(); return; }
    if (e.target.closest('#cfShare')) { const code = S.sheet.code; closeLayer(() => toast(`Code ${code} ready to share`)); return; }
    if (e.target.closest('#cfX')) closeLayer();
  });
  l.addEventListener('input', (e) => { if (e.target.id === 'cfName') { S.sheet.name = e.target.value; const go = $('#cfGo'); if (go) go.disabled = !S.sheet.name.trim(); } });
  l.addEventListener('keydown', (e) => { if (e.target.id === 'cfName' && e.key === 'Enter') createSubmit(); });
}
export function createIOS() {
  showLayer(`<div class="dimmer" id="dim"></div><div class="sheet"><div class="grab"></div>
      <div class="shead"><h2 id="cfTitle"></h2><button class="x" id="cfX" aria-label="Close">${ic('close')}</button></div>
      <div class="sbody" id="cfBody"></div></div>`, (l) => { $('#dim', l).addEventListener('click', () => closeLayer()); bindCreate(l); });
  paintCreateIOS();
}
export function paintCreateIOS(swap) {
  const sh = S.sheet; const body = $('#cfBody'); if (!body) return;
  $('#cfTitle').textContent = sh.step === 'done' ? 'Your code' : 'Create a code';
  if (sh.step === 'done') body.innerHTML = `${createDoneHTML()}<button class="primary" id="cfShare">Share this code</button>`;
  else {
    const focused = document.activeElement && document.activeElement.id === 'cfName';
    body.innerHTML = `<div class="group"><input class="cf-name" id="cfName" placeholder="Meetup name" maxlength="80" value="${esc(sh.name)}" aria-label="Meetup name" autocomplete="off"></div>${createFormHTML()}<button class="primary" id="cfGo" ${sh.name.trim() ? '' : 'disabled'}>Create</button>`;
    if (focused) $('#cfName').focus();
  }
  if (swap && !reduced.matches) { body.classList.remove('swapin'); void body.offsetWidth; body.classList.add('swapin'); }
}
