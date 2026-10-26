// iPhone sheets and menus: the consent sheet, the request sheet and the pull-down menus.
import { $, $$, esc, ic, DUR, later, S, cardById } from './core.js';
import { SHAREABLE, RANGES, SCORES, PER_DAY, rangeLabel } from './data.js';
import { renderIOS, go, toggle } from './ios.js';
import { syncURL } from './app.js';

const layer = () => $('#layer');

export function openLayer(spec) {
  S.layer = spec;
  if (spec.type === 'request') S.layer.draft = draftFor(spec.id);
  renderLayerIOS(false);
  syncURL();
}
export function draftFor(id) {
  const n = id && S.needs.find((x) => x.id === id);
  if (n) return { text: n.text, range: n.range, window: n.window ? { ...n.window } : null, paused: n.paused };
  return { text: '', range: 2000, window: null, paused: false };
}
export function closeLayer(after) {
  const l = layer(); if (!l) return;
  $$('.dimmer, .sheet, .menu', l).forEach((el) => el.classList.remove('on'));
  later(() => { S.layer = null; l.innerHTML = ''; if (after) after(); syncURL(); }, DUR());
}
function animateIn(l, instant) {
  const els = $$('.dimmer, .sheet, .menu', l);
  if (instant) { els.forEach((el) => { el.style.transition = 'none'; el.classList.add('on'); void el.offsetWidth; el.style.transition = ''; }); return; }
  void l.offsetWidth;
  requestAnimationFrame(() => els.forEach((el) => el.classList.add('on')));
}

// ---------- menus ----------
export function menuItems(name) {
  const nb = S.nb;
  if (name === 'more') {
    return [
      { label: 'Pause for 1 hour', act: () => { nb.paused = '4:41 PM'; } },
      { label: 'Pause until tomorrow', act: () => { nb.paused = 'tomorrow'; } },
      { label: 'Turn off', danger: true, sep: true, act: () => { nb.on = false; nb.paused = null; S.page = 'off'; } },
    ];
  }
  const pick = (list, cur, set) => list.map(([v, label]) => ({ label, checked: v === cur, act: () => set(v) }));
  if (name === 'range') return pick(RANGES, nb.range, (v) => { nb.range = v; });
  if (name === 'score') return pick(SCORES, nb.min, (v) => { nb.min = v; });
  if (name === 'perday') return pick(PER_DAY, nb.alerts.max, (v) => { nb.alerts.max = v; });
  if (name === 'card') return pick(SHAREABLE.map((id) => [id, cardById(id).name]), nb.card, (v) => { nb.card = v; });
  if (name === 'needrange') return pick(RANGES, S.layer.draft.range, (v) => { S.layer.draft.range = v; });
  return [];
}
export function placeMenu(menu, anchor, host) {
  const hr = host.getBoundingClientRect(); const ar = anchor.getBoundingClientRect();
  const k = hr.width / host.offsetWidth || 1;
  const ax = (ar.left - hr.left) / k, ay = (ar.top - hr.top) / k, aw = ar.width / k, ah = ar.height / k;
  const W = menu.offsetWidth, H = menu.offsetHeight, HW = host.offsetWidth, HH = host.offsetHeight;
  const rightSide = ax + aw / 2 > HW / 2;
  let left = rightSide ? ax + aw - W : ax;
  left = Math.max(12, Math.min(HW - W - 12, left));
  let top = ay + ah + 8; let up = false;
  if (top + H > HH - 24) { top = Math.max(56, ay - H - 8); up = true; }
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  menu.style.transformOrigin = `${rightSide ? 'right' : 'left'} ${up ? 'bottom' : 'top'}`;
}
// A pull-down menu appended to the layer; it closes itself, or the whole layer when it is the layer.
function showMenu(name, anchorSel, opts = {}) {
  const l = layer(); const anchor = $(anchorSel); if (!l || !anchor) return;
  const items = menuItems(name);
  const checks = items.some((x) => 'checked' in x);
  const box = document.createElement('div');
  box.className = 'menuwrap';
  box.innerHTML = `<div class="mcatch"></div><div class="menu${checks ? ' checks' : ''}" role="menu">${items.map((x, i) => `${x.sep ? '<i class="msep"></i>' : ''}<button role="menuitem${checks ? 'radio' : ''}" ${checks ? `aria-checked="${x.checked}"` : ''} class="mitem${x.danger ? ' danger' : ''}" data-i="${i}">${checks ? `<span class="mck">${x.checked ? ic('check') : ''}</span>` : ''}${esc(x.label)}</button>`).join('')}</div>`;
  l.appendChild(box);
  const menu = $('.menu', box);
  placeMenu(menu, anchor, $('#screen'));
  const close = (after) => {
    if (opts.nested) { menu.classList.remove('on'); later(() => { box.remove(); if (after) after(); }, DUR()); } else closeLayer(after);
  };
  $('.mcatch', box).addEventListener('click', () => close());
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.mitem'); if (!b) return;
    const item = items[Number(b.dataset.i)];
    item.act();
    close(() => (opts.nested ? opts.onPick?.() : renderIOS()));
  });
  if (opts.instant) { menu.style.transition = 'none'; menu.classList.add('on'); void menu.offsetWidth; menu.style.transition = ''; } else requestAnimationFrame(() => menu.classList.add('on'));
}

// ---------- sheets ----------
function swatches(sel) {
  const c = cardById(sel);
  return `<div class="slabel">Share</div><div class="swrow" role="radiogroup" aria-label="Card">${SHAREABLE.map((id) => { const x = cardById(id); return `<button class="swbtn${id === sel ? ' on' : ''}" data-card="${id}" role="radio" aria-checked="${id === sel}" aria-label="${esc(x.name)}"><span class="swg" data-kind="${x.kind}">${ic(x.kind)}</span></button>`; }).join('')}<span class="swname">${esc(c.name)}</span></div>`;
}
function consentHTML() {
  const c = S.consent;
  return `<div class="dimmer" id="dim"></div><div class="sheet" role="dialog" aria-label="Turn on Nearby?"><div class="grab"></div>
    <div class="shead"><h2>Turn on Nearby?</h2><button class="x" id="shX" aria-label="Close">${ic('close')}</button></div>
    <p class="sline">People nearby who turn this on see your card and a rough distance. You see theirs.</p>
    ${swatches(c.card)}
    <div class="cgs-group sgroup"><div class="row"><span class="grow"><span class="t">Alerts in the background</span></span>${toggle(c.background, 'id="bgAlerts" aria-label="Alerts in the background"')}</div></div>
    <button class="primary" id="consentGo">Turn on</button><button class="textbtn" id="consentNo">Not now</button></div>`;
}
function requestInner() {
  const d = S.layer.draft; const edit = Boolean(S.layer.id);
  const w = d.window;
  const dp = (day, time) => `<span class="dp">${day}</span><span class="dp">${time}</span>`;
  return `<div class="grab"></div>
    <div class="shead"><h2>${edit ? 'Edit request' : 'New request'}</h2><button class="x" id="shX" aria-label="Close">${ic('close')}</button></div>
    <div class="field"><textarea id="needText" rows="1" maxlength="200" placeholder="Who are you looking for?" aria-label="Who are you looking for?">${esc(d.text)}</textarea></div>
    <div class="cgs-group sgroup" style="--inset:16px">
      <button class="row" id="needRange" aria-haspopup="menu"><span class="grow"><span class="t">Within</span></span><span class="val">${esc(rangeLabel(d.range))}</span><span class="ud">${ic('updown')}</span></button>
      <div class="row"><span class="grow"><span class="t">Time window</span></span>${toggle(Boolean(w), 'id="needWindow" aria-label="Time window"')}</div>
      ${w ? `<div class="row"><span class="grow"><span class="t">From</span></span>${dp('Today', esc(w.from))}</div><div class="row"><span class="grow"><span class="t">Until</span></span>${dp('Today', esc(w.until))}</div>` : ''}
      ${edit ? `<div class="row"><span class="grow"><span class="t">Paused</span></span>${toggle(d.paused, 'id="needPaused" aria-label="Paused"')}</div>` : ''}
    </div>
    ${edit ? '<div class="cgs-group sgroup"><button class="row danger" id="needDelete">Delete request</button></div>' : ''}
    <button class="primary" id="needSave" ${d.text.trim() ? '' : 'disabled'}>Save</button>`;
}
function requestHTML() {
  return `<div class="dimmer" id="dim"></div><div class="sheet" role="dialog" aria-label="${S.layer.id ? 'Edit request' : 'New request'}">${requestInner()}</div>`;
}
function bindSheet(l) {
  const dismiss = () => closeLayer(() => renderIOS());
  const sheet = $('.sheet', l);
  $('#dim', l)?.addEventListener('click', dismiss);
  if (S.layer.type === 'consent') {
    sheet.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('#shX') || t.closest('#consentNo')) { dismiss(); return; }
      if (t.closest('#bgAlerts')) { S.consent.background = !S.consent.background; t.closest('#bgAlerts').setAttribute('aria-checked', String(S.consent.background)); return; }
      const sw = t.closest('[data-card]');
      if (sw) {
        S.consent.card = sw.dataset.card;
        $$('.swbtn', sheet).forEach((b) => { const on = b.dataset.card === S.consent.card; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
        $('.swname', sheet).textContent = cardById(S.consent.card).name;
        return;
      }
      if (t.closest('#consentGo')) {
        Object.assign(S.nb, { on: true, paused: null, card: S.consent.card, fresh: true });
        S.nb.access = S.consent.background ? 'always' : 'limited';
        closeLayer(() => go('nearby'));
      }
    });
    return;
  }
  const d = S.layer.draft;
  const repaint = () => { sheet.innerHTML = requestInner(); fit(sheet); };
  fit(sheet);
  sheet.addEventListener('input', (e) => { if (e.target.id === 'needText') { d.text = e.target.value; $('#needSave', sheet).disabled = !d.text.trim(); fit(sheet); } });
  sheet.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#shX')) { dismiss(); return; }
    if (t.closest('#needWindow')) { d.window = d.window ? null : { from: '3:00 PM', until: '6:00 PM' }; repaint(); return; }
    if (t.closest('#needPaused')) { d.paused = !d.paused; t.closest('#needPaused').setAttribute('aria-checked', String(d.paused)); return; }
    if (t.closest('#needRange')) { showMenu('needrange', '#needRange', { nested: true, onPick: repaint }); return; }
    if (t.closest('#needDelete')) { const id = S.layer.id; closeLayer(() => { S.needs = S.needs.filter((n) => n.id !== id); renderIOS(); }); return; }
    if (t.closest('#needSave')) {
      const id = S.layer.id; const v = { text: d.text.trim(), range: d.range, window: d.window, paused: d.paused };
      if (!v.text) return;
      closeLayer(() => {
        if (id) Object.assign(S.needs.find((n) => n.id === id), v);
        else S.needs.unshift({ id: 'n' + Date.now().toString(36), label: v.text, ended: false, ...v });
        renderIOS();
      });
    }
  });
}

// The request field grows with its text.
export function fit(root) { const ta = root.querySelector('textarea'); if (!ta) return; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

// ---------- render ----------
export function renderLayerIOS(instant) {
  const l = layer(); if (!l || !S.layer) return;
  const L = S.layer;
  if (L.type === 'menu') { l.innerHTML = ''; showMenu(L.menu, L.anchor, { instant }); return; }
  l.innerHTML = L.type === 'consent' ? consentHTML() : requestHTML();
  bindSheet(l);
  animateIn(l, instant);
  if (!instant && L.type === 'request' && !L.id) later(() => $('#needText')?.focus(), DUR());
}
