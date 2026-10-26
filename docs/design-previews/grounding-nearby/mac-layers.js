// Mac dialogs (AppDialog: consent, request) and menus.
import { $, $$, esc, ic, DUR, later, S, cardById } from './core.js';
import { SHAREABLE, RANGES } from './data.js';
import { menuItems, placeMenu, draftFor, fit } from './ios-layers.js';
import { renderMain, mgo, ksw } from './mac.js';
import { syncURL } from './app.js';

const layer = () => $('#mlayer');
export function openMacLayer(spec) {
  S.layer = spec;
  if (spec.type === 'request') S.layer.draft = draftFor(spec.id);
  renderMacLayer(false);
  syncURL();
}
export function closeMacLayer(after) {
  const l = layer(); if (!l) return;
  $$('.k-overlay, .k-menu', l).forEach((el) => el.classList.remove('on'));
  later(() => { S.layer = null; l.innerHTML = ''; if (after) after(); syncURL(); }, DUR());
}
function on(l, instant) {
  const els = $$('.k-overlay, .k-menu', l);
  if (instant) { els.forEach((el) => { el.style.transition = 'none'; el.classList.add('on'); void el.offsetWidth; el.style.transition = ''; }); return; }
  void l.offsetWidth;
  requestAnimationFrame(() => els.forEach((el) => el.classList.add('on')));
}

function consentHTML() {
  const c = S.consent;
  return `<div class="k-overlay" id="mdim"><div class="k-dialog" role="dialog" aria-modal="true" aria-labelledby="mdTitle">
    <h2 class="k-dtitle" id="mdTitle">Turn on Nearby?</h2>
    <p class="k-ddesc">People nearby who turn this on see your card and a rough distance. You see theirs.</p>
    <div class="k-plabel">Share</div>
    <div class="k-pcards" role="radiogroup" aria-label="Card">${SHAREABLE.map((id) => { const x = cardById(id); return `<button class="k-pcard${id === c.card ? ' on' : ''}" data-mcard="${id}" data-kind="${x.kind}" role="radio" aria-checked="${id === c.card}" aria-label="${esc(x.name)}">${ic(x.kind)}</button>`; }).join('')}<span class="k-ppick">${esc(cardById(c.card).name)}</span></div>
    <div class="k-swrow first"><span>Alerts in the background</span>${ksw(c.background, 'id="mBg" aria-label="Alerts in the background"')}</div>
    <div class="k-dactions"><button class="k-btn quiet" id="mNo">Not now</button><button class="k-btn" id="mGo">Turn on</button></div>
  </div></div>`;
}
function requestInner() {
  const d = S.layer.draft; const edit = Boolean(S.layer.id); const w = d.window;
  return `<h2 class="k-dtitle" id="mdTitle">${edit ? 'Edit request' : 'New request'}</h2>
    <textarea class="k-input area" id="mNeedText" rows="1" maxlength="200" placeholder="Who are you looking for?" aria-label="Who are you looking for?">${esc(d.text)}</textarea>
    <div class="k-field"><span>Within</span><div class="k-rchips" role="radiogroup" aria-label="Within">${RANGES.map(([v, l]) => `<button class="k-rchip${v === d.range ? ' on' : ''}" data-mrange="${v}" role="radio" aria-checked="${v === d.range}">${esc(l)}</button>`).join('')}</div></div>
    <div class="k-swrow"><span>Time window</span>${ksw(Boolean(w), 'id="mWin" aria-label="Time window"')}</div>
    ${w ? `<div class="k-pair2"><div class="k-field"><span>From</span><span class="k-input val">Today, ${esc(w.from)}${ic('down')}</span></div><div class="k-field"><span>Until</span><span class="k-input val">Today, ${esc(w.until)}${ic('down')}</span></div></div>` : ''}
    ${edit ? `<div class="k-swrow"><span>Paused</span>${ksw(d.paused, 'id="mPaused" aria-label="Paused"')}</div>` : ''}
    <div class="k-dactions">${edit ? '<button class="k-btn danger-quiet" id="mDel">Delete request</button><span class="sp"></span>' : ''}<button class="k-btn quiet" id="mCancel">Cancel</button><button class="k-btn" id="mSave" ${d.text.trim() ? '' : 'disabled'}>Save</button></div>`;
}
function requestHTML() {
  return `<div class="k-overlay" id="mdim"><div class="k-dialog" role="dialog" aria-modal="true" aria-labelledby="mdTitle">${requestInner()}</div></div>`;
}
function bindDialog(l) {
  const dlg = $('.k-dialog', l);
  const dismiss = () => closeMacLayer(() => renderMain());
  $('#mdim', l).addEventListener('mousedown', (e) => { if (e.target.id === 'mdim') dismiss(); });
  if (S.layer.type === 'consent') {
    dlg.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('#mNo')) { dismiss(); return; }
      if (t.closest('#mBg')) { S.consent.background = !S.consent.background; t.closest('#mBg').setAttribute('aria-checked', String(S.consent.background)); return; }
      const pc = t.closest('[data-mcard]');
      if (pc) {
        S.consent.card = pc.dataset.mcard;
        $$('.k-pcard', dlg).forEach((b) => { const sel = b.dataset.mcard === S.consent.card; b.classList.toggle('on', sel); b.setAttribute('aria-checked', String(sel)); });
        $('.k-ppick', dlg).textContent = cardById(S.consent.card).name;
        return;
      }
      if (t.closest('#mGo')) {
        Object.assign(S.nb, { on: true, paused: null, card: S.consent.card });
        closeMacLayer(() => mgo('nearby'));
      }
    });
    return;
  }
  const d = S.layer.draft;
  const repaint = () => { const focus = document.activeElement && document.activeElement.id; dlg.innerHTML = requestInner(); fit(dlg); if (focus === 'mNeedText') $('#mNeedText', dlg).focus(); };
  fit(dlg);
  dlg.addEventListener('input', (e) => { if (e.target.id === 'mNeedText') { d.text = e.target.value; $('#mSave', dlg).disabled = !d.text.trim(); fit(dlg); } });
  dlg.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#mCancel')) { dismiss(); return; }
    const rc = t.closest('[data-mrange]'); if (rc) { d.range = Number(rc.dataset.mrange); repaint(); return; }
    if (t.closest('#mWin')) { d.window = d.window ? null : { from: '3:00 PM', until: '6:00 PM' }; repaint(); return; }
    if (t.closest('#mPaused')) { d.paused = !d.paused; t.closest('#mPaused').setAttribute('aria-checked', String(d.paused)); return; }
    if (t.closest('#mDel')) { const id = S.layer.id; closeMacLayer(() => { S.needs = S.needs.filter((n) => n.id !== id); renderMain(); }); return; }
    if (t.closest('#mSave')) {
      const id = S.layer.id; const v = { text: d.text.trim(), range: d.range, window: d.window, paused: d.paused };
      if (!v.text) return;
      closeMacLayer(() => {
        if (id) Object.assign(S.needs.find((n) => n.id === id), v);
        else S.needs.unshift({ id: 'n' + Date.now().toString(36), label: v.text, ended: false, ...v });
        renderMain();
      });
    }
  });
}
function showMenu(name, anchorSel, instant) {
  const l = layer(); const anchor = $(anchorSel); if (!l || !anchor) return;
  const items = menuItems(name);
  const checks = items.some((x) => 'checked' in x);
  l.innerHTML = `<div class="k-mcatch"></div><div class="k-menu" role="menu">${items.map((x, i) => `${x.sep ? '<i class="k-msep"></i>' : ''}<button class="k-mitem${x.danger ? ' danger' : ''}" role="${checks ? 'menuitemradio' : 'menuitem'}" ${checks ? `aria-checked="${x.checked}"` : ''} data-i="${i}">${checks ? `<span class="k-tick">${x.checked ? ic('check') : ''}</span>` : ''}${esc(x.label)}</button>`).join('')}</div>`;
  const menu = $('.k-menu', l);
  placeMenu(menu, anchor, $('#mac'));
  $('.k-mcatch', l).addEventListener('mousedown', () => closeMacLayer());
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.k-mitem'); if (!b) return;
    items[Number(b.dataset.i)].act();
    closeMacLayer(() => { if (S.page === 'off') mgo('off'); else renderMain(); });
  });
  on(l, instant);
}
export function renderMacLayer(instant) {
  const l = layer(); if (!l || !S.layer) return;
  const L = S.layer;
  if (L.type === 'menu') { showMenu(L.menu, L.anchor, instant); return; }
  l.innerHTML = L.type === 'consent' ? consentHTML() : requestHTML();
  bindDialog(l);
  on(l, instant);
  if (!instant && L.type === 'request' && !L.id) later(() => $('#mNeedText')?.focus(), DUR());
}
