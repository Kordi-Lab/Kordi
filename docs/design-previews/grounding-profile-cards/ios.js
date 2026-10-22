// iPhone: rows under the wallet, the room sheet, New card and the card flip.
import { $, $$, esc, DUR, later, ic, bird, S, cardById, activeCard, takenKinds, ios, geo } from './core.js';
import { KINDS, DESIGNS, MAX_CARDS, SOURCES, PEOPLE } from './data.js';
import { visibleTopics, topicsHTML, cardInner, cardHTML, avatar, renderChip, syncWalletCards, layoutWallet, startBuild, layer, overlayHost, closeLayer, showLayer, instantOn, toast, bindCarousel, dotsHTML, setDots, suggHTML } from './cards.js';
import { listedRooms, joinRoom, digitsHTML, bindDigits, openCreate } from './rooms.js';
import { macRefresh, macNew } from './mac.js';
import { syncURL } from './app.js';

// ---------- below the wallet ----------
export function roomSub(r) {
  const shared = r.sharing ? cardById(r.sharing) : null;
  if (r.mine) return [`Sharing ${shared ? shared.name : KINDS[r.kind].label}`, 'you', r.people === 1 ? '1 person' : `${r.people} people`].join(' · ');
  return [shared ? `Sharing ${shared.name}` : KINDS[r.kind].label, `${r.people} people`, r.open ? '' : 'Closed'].filter(Boolean).join(' · ');
}
export function renderBelow() {
  if (!ios()) { macRefresh(); return; }
  const box = $('#below'); if (!box) return;
  const c = S.suggest && !S.cards.length ? null : activeCard();
  const ready = c && visibleTopics(c).length;
  const anyReady = S.cards.some((x) => x.topics.length);
  const showRooms = S.cards.length > 0;
  if (ios()) {
    box.innerHTML = `
      <div class="section"><div class="group pcgroup${anyReady ? '' : ' off'}"><div class="row pcrow"><span class="icon">${ic('hash')}</span><span class="grow"><div class="title">Pair code</div></span>${digitsHTML(!anyReady)}</div>
        ${S.codeErr ? `<div class="pcerr">${esc(S.codeErr)}</div>` : ''}<button class="pclink" id="createLink" ${anyReady ? '' : 'disabled'}>Create a code</button></div></div>
      ${c ? `<div class="section yourcard" data-kind="${c.kind}"><div class="section-title">Your card</div><div class="group"><button class="row" id="yourRow"><span class="mini" data-kind="${c.kind}"></span><span class="grow"><div class="title">${esc(c.name)}</div></span><span class="chev">${ic('chev')}</span></button>
        ${ready ? `<div class="tags">${visibleTopics(c).map((t) => `<span class="tag"><i></i>${esc(t)}</span>`).join('')}</div>` : ''}</div></div>` : ''}
      ${showRooms ? `<div class="section"><div class="section-title">Rooms</div><div class="group">${listedRooms().map(roomRowIOS).join('')}</div></div>` : ''}`;
  }
  bindDigits(box);
  $('#createLink')?.addEventListener('click', () => openCreate(S.active));
  $('#yourRow')?.addEventListener('click', () => { if (c && !c.suggested) openDetail(c.id); });
  $$('[data-room]', box).forEach((b) => b.addEventListener('click', () => openRoom(b.dataset.room)));
}
export function roomLead(r) { const shared = r.sharing ? cardById(r.sharing) : null; return shared ? `<span class="mini" data-kind="${shared.kind}"></span>` : `<span class="mini none" data-kind="${r.kind}"></span>`; }
export function roomRowIOS(r) {
  const trail = r.sharing ? `<span class="chev">${ic('chev')}</span>` : '<span class="small-btn">Join</span>';
  return `<button class="row" data-room="${r.id}" ${r.open ? '' : 'disabled'}>${roomLead(r)}<span class="grow"><div class="title">${esc(r.name)}</div><div class="sub">${esc(roomSub(r))}</div></span>${trail}</button>`;
}
export function openRoom(id, anchor) {
  const r = S.rooms.find((x) => x.id === id); if (!r || !r.open) return;
  const suggested = S.cards.find((c) => c.kind === r.kind && c.topics.length);
  openChoose('room', r.sharing || suggested?.id || S.active, { room: r.id, suggested: suggested?.id || null, anchor });
}

// ---------- choose a card ----------
export function chooseList() { return S.cards.filter((c) => c.topics.length); }
export function openChoose(purpose, sel, opts = {}) {
  const list = chooseList(); if (!list.length) return;
  if (!list.some((c) => c.id === sel)) sel = list[0].id;
  S.sheet = { type: 'choose', purpose, sel, step: 'pick', room: opts.room || null, suggested: opts.suggested || null };
  S.fanned = false; layoutWallet();
  chooseIOS();
  if (opts.instant) instantOn();
  syncURL();
}
export function chooseTitle() { return S.rooms.find((r) => r.id === S.sheet.room).name; }
export function chooseSub() {
  const sh = S.sheet; if (sh.purpose !== 'room') return '';
  const r = S.rooms.find((x) => x.id === sh.room);
  return `<span class="stackav">${PEOPLE.map((p) => avatar(p, 22)).join('')}</span><span>Tomas, Priya and ${r.people - 2} others</span>`;
}
export const primaryLabel = () => 'Share this card';
export function chooseIOS() {
  const sh = S.sheet; const list = chooseList();
  const idx = Math.max(0, list.findIndex((c) => c.id === sh.sel));
  const body = `
    <div class="car" id="car" style="--pad:${(370 - geo().cw * 0.8) / 2}px">${list.map((c, i) => `<div class="car-item${i === idx ? ' is-sel' : ''}" style="--z:.8">${c.id === sh.suggested ? suggHTML() : ''}${cardHTML(c)}</div>`).join('')}</div>
    ${dotsHTML(list.length, idx)}
    <button class="primary" id="chGo">${primaryLabel()}</button>`;
  const sub = chooseSub();
  showLayer(`<div class="dimmer" id="dim"></div><div class="sheet"><div class="grab"></div>
      <div class="shead"><h2>${esc(chooseTitle())}</h2><button class="x" id="chX" aria-label="Close">${ic('close')}</button></div>
      ${sub ? `<div class="sline">${sub}</div>` : ''}
      <div class="sbody" id="sbody">${body}</div></div>`, bindChoose);
}
export function bindChoose(l) {
  const dismiss = () => { S.code = ''; closeLayer(() => renderBelow()); };
  $('#chX', l).addEventListener('click', dismiss);
  $('#dim', l)?.addEventListener('click', dismiss);
  const car = $('#car', l);
  const list = chooseList();
  if (car) bindCarousel(car, (i) => { S.sheet.sel = list[i].id; setDots(l, i); });
  $('#chGo', l)?.addEventListener('click', confirmChoose);
  $('#chDone', l)?.addEventListener('click', () => closeLayer());
}
export function confirmChoose() {
  const sh = S.sheet;
  const r = S.rooms.find((x) => x.id === sh.room); const c = cardById(sh.sel);
  const was = r.sharing;
  joinRoom(r, c);
  closeLayer(() => { renderBelow(); toast(was && was !== c.id ? `Now sharing ${c.name}` : `Sharing ${c.name} in ${r.name}`); });
}
// ---------- new card ----------
export function newDraft(i) { const kind = DESIGNS[i]; return { id: 'draft-' + kind, kind, name: '', focus: '', topics: [], hidden: [] }; }
export function editCardHTML(i, sh) {
  const kind = DESIGNS[i]; const k = KINDS[kind];
  const taken = takenKinds().includes(kind);
  const ph = k.fixed ? k.label : k.placeholder || k.label;
  return `<div class="gcard edit" data-kind="${kind}">
    <div class="gc-head"><span class="gc-glyph">${ic(kind)}</span><label class="gc-field"><input class="gc-name" data-f="name" placeholder="${esc(ph)}" value="${esc(sh.name)}" maxlength="40" aria-label="Name" ${taken ? 'disabled' : ''} autocomplete="off"></label>${taken ? '<span class="gc-badge">In your wallet</span>' : ''}</div>
    <div class="gc-focus"><label class="gc-field"><input class="gc-focus-in" data-f="focus" placeholder="Focus" value="${esc(sh.focus)}" maxlength="200" aria-label="Focus" ${taken ? 'disabled' : ''} autocomplete="off"></label></div>
    <div class="gc-topics">${topicsHTML(newDraft(i), { skeleton: true })}</div>${bird()}</div>`;
}
export function canCreate() {
  const sh = S.sheet; const kind = DESIGNS[sh.idx];
  if (takenKinds().includes(kind)) return false;
  return KINDS[kind].fixed || Boolean(sh.name.trim());
}
export function firstFreeDesign() { const t = takenKinds(); const i = DESIGNS.findIndex((k) => !t.includes(k)); return i < 0 ? 3 : i; }
export function openNew(opts = {}) {
  if (S.cards.length >= MAX_CARDS) return;
  S.fanned = false; layoutWallet();
  S.sheet = { type: 'new', idx: opts.idx ?? firstFreeDesign(), name: opts.name || '', focus: opts.focus || '' };
  const sh = S.sheet;
  if (!ios()) { macNew(opts); if (opts.instant) instantOn(); syncURL(); return; }
  const z = 0.86;
  const pad = (370 - geo().cw * z) / 2;
  const car = `<div class="car" id="car" style="--pad:${pad}px">${DESIGNS.map((_, i) => `<div class="car-item${i === sh.idx ? ' is-sel' : ''}" style="--z:${z}">${editCardHTML(i, sh)}</div>`).join('')}</div>
    <div class="carlabel" id="carlabel"></div>${dotsHTML(DESIGNS.length, sh.idx)}`;
  showLayer(`<div class="dimmer" id="dim"></div><div class="sheet"><div class="grab"></div>
      <div class="shead"><h2>New card</h2><button class="x" id="nX" aria-label="Close">${ic('close')}</button></div>
      <div class="sbody">${car}<button class="primary" id="nGo">Create</button></div></div>`, bindNew);
  if (opts.instant) instantOn();
  syncURL();
}
export function bindNew(l) {
  const close = () => closeLayer();
  $('#nX', l).addEventListener('click', close);
  $('#nCancel', l)?.addEventListener('click', close);
  $('#dim', l).addEventListener('click', (e) => { if (e.target.id === 'dim') close(); });
  const paint = () => {
    const sh = S.sheet; const kind = DESIGNS[sh.idx];
    $('#carlabel', l).innerHTML = `<b>${esc(KINDS[kind].label)}</b>`;
    setDots(l, sh.idx);
    $('#nGo', l).disabled = !canCreate();
    if ($('#nPrev', l)) { $('#nPrev', l).disabled = sh.idx === 0; $('#nNext', l).disabled = sh.idx === DESIGNS.length - 1; }
  };
  const ctl = bindCarousel($('#car', l), (i) => { S.sheet.idx = i; paint(); });
  $('#nPrev', l)?.addEventListener('click', () => ctl.go(S.sheet.idx - 1));
  $('#nNext', l)?.addEventListener('click', () => ctl.go(S.sheet.idx + 1));
  l.addEventListener('input', (e) => {
    const f = e.target.dataset.f; if (!f) return;
    S.sheet[f] = e.target.value;
    $$(`input[data-f="${f}"]`, l).forEach((inp) => { if (inp !== e.target) inp.value = e.target.value; });
    paint();
  });
  l.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.f && canCreate()) createCard(); });
  $('#nGo', l).addEventListener('click', createCard);
  paint();
}
export function createCard() {
  if (!canCreate()) return;
  const sh = S.sheet; const kind = DESIGNS[sh.idx];
  const card = { id: 'c' + Date.now().toString(36), kind, name: sh.name.trim() || KINDS[kind].label, focus: sh.focus.trim(), topics: [], hidden: [], sources: ['Memory', 'Notes'] };
  closeLayer(() => {
    S.cards.push(card); S.suggest = false; S.active = card.id; S.fanned = false;
    syncWalletCards();
    renderChip(true); renderBelow();
    later(() => startBuild(card.id), 60);
  });
}

// ---------- card detail (flip) ----------
export function backHTML(c, renaming) {
  const all = c.topics || [];
  return `<div class="gb-scroll"><div class="gb-in" id="gbin">
    <div class="gb-head"><span class="gc-glyph">${ic(c.kind)}</span>${renaming ? `<input class="gb-name" id="gbName" value="${esc(c.name)}" maxlength="40" aria-label="Name">` : `<span class="gb-name">${esc(c.name)}</span>`}<button class="gb-x" id="gbX" aria-label="Close">${ic('close')}</button></div>
    ${c.focus ? `<div class="gb-focus">${esc(c.focus)}</div>` : ''}
    <div class="gb-sec">Topics</div>
    <div class="gb-list">${all.map((t) => { const off = (c.hidden || []).includes(t); return `<div class="gb-row${off ? ' off' : ''}"><span>${esc(t)}</span><button class="gb-hide" data-t="${esc(t)}" aria-pressed="${off}">${ic(off ? 'eye' : 'eyeOff')}${off ? 'Show' : 'Hide'}</button></div>`; }).join('')}</div>
    <div class="gb-sec">Sources</div>
    <div class="gb-src">${(c.sources || []).map((s) => `<span>${ic(SOURCES[s] || 'note')}${esc(s)}</span>`).join('')}</div>
    <div class="gb-acts"><button data-act="share">${ic('share')}Share</button><button data-act="rename">${ic('pencil')}Rename</button><button data-act="delete" class="danger">${ic('trash')}Delete</button></div>
  </div></div>`;
}
export function hostScale(host) { return host.getBoundingClientRect().width / host.offsetWidth || 1; }
export function detailTarget(host) {
  const g = geo();
  const top = ios() ? 104 : 84;
  const left = ios() ? (host.offsetWidth - g.cw) / 2 : 68 + 264 + (host.offsetWidth - 68 - 264 - g.cw) / 2;
  return { top, left, maxH: host.offsetHeight - top - (ios() ? 44 : 40) };
}
export function srcRect(host, id) {
  const src = $(`#wallet .gcard[data-id="${id}"]`); if (!src) return null;
  const hr = host.getBoundingClientRect(); const sr = src.getBoundingClientRect(); const k = hostScale(host);
  return { el: src, top: (sr.top - hr.top) / k, left: (sr.left - hr.left) / k };
}
export function openDetail(id, opts = {}) {
  const c = cardById(id); if (!c || !c.topics.length) return;
  S.fanned = false; layoutWallet();
  S.sheet = { type: 'detail', id, renaming: false };
  const host = overlayHost(); const g = geo();
  const ov = document.createElement('div');
  ov.className = 'dov'; ov.id = 'dov';
  ov.innerHTML = `<div class="ddim"></div><div class="flip" style="width:${g.cw}px;height:${g.ch}px"><div class="flip-in">
      <div class="gcard face" data-kind="${c.kind}">${cardInner(c)}</div>
      <div class="gback face" data-kind="${c.kind}" id="gback">${backHTML(c, false)}</div></div></div>`;
  layer().innerHTML = ''; layer().appendChild(ov);
  const flip = $('.flip', ov);
  const t = detailTarget(host);
  // The flip starts where the card sits in the wallet, then lifts to the centre.
  const s = srcRect(host, id);
  const from = !opts.instant && s ? s : t;
  flip.style.top = from.top + 'px'; flip.style.left = from.left + 'px';
  if (opts.instant) { $$('.flip, .flip-in, .ddim', ov).forEach((el) => { el.style.transition = 'none'; }); }
  void ov.offsetWidth;
  const go = () => {
    if (s) s.el.style.visibility = 'hidden';
    ov.classList.add('open');
    flip.style.top = t.top + 'px'; flip.style.left = t.left + 'px';
    fitDetail();
    if (opts.instant) { void ov.offsetWidth; $$('.flip, .flip-in, .ddim', ov).forEach((el) => { el.style.transition = ''; }); }
  };
  if (opts.instant) go(); else requestAnimationFrame(go);
  bindDetail(ov);
  syncURL();
}
export function fitDetail() {
  const ov = $('#dov'); if (!ov) return;
  const host = overlayHost(); const t = detailTarget(host);
  const h = Math.min($('#gbin', ov).offsetHeight, t.maxH);
  $('.flip', ov).style.height = Math.max(h, geo().ch) + 'px';
}
export function paintBack() {
  const c = cardById(S.sheet.id); const back = $('#gback');
  back.innerHTML = backHTML(c, S.sheet.renaming);
  fitDetail();
  if (S.sheet.renaming) { const inp = $('#gbName'); inp.focus(); inp.select(); }
}
export function bindDetail(ov) {
  $('.ddim', ov).addEventListener('click', closeDetail);
  ov.addEventListener('click', (e) => {
    if (e.target.closest('#gbX')) { closeDetail(); return; }
    const hide = e.target.closest('.gb-hide');
    if (hide) {
      const c = cardById(S.sheet.id); const t = hide.dataset.t;
      c.hidden = c.hidden.includes(t) ? c.hidden.filter((x) => x !== t) : c.hidden.concat(t);
      paintBack(); refreshCard(c);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename') { S.sheet.renaming = true; paintBack(); }
    if (act === 'share') { const id = S.sheet.id; closeDetail(() => openCreate(id)); }
    if (act === 'delete') openConfirm(S.sheet.id);
  });
  ov.addEventListener('keydown', (e) => { if (e.target.id === 'gbName' && e.key === 'Enter') saveRename(); });
  ov.addEventListener('focusout', (e) => { if (e.target.id === 'gbName') saveRename(); });
}
export function saveRename() {
  if (!S.sheet || !S.sheet.renaming) return;
  const c = cardById(S.sheet.id); const v = $('#gbName').value.trim();
  if (v) c.name = v;
  S.sheet.renaming = false;
  paintBack(); refreshCard(c); renderChip(); renderBelow();
}
export function refreshCard(c) {
  const el = $(`#wallet .gcard[data-id="${c.id}"]`); if (el) el.innerHTML = cardInner(c, { flip: true });
  const front = $('#dov .gcard.face'); if (front) front.innerHTML = cardInner(c);
  if (c.id === S.active) renderBelow();
}
export function closeDetail(after) {
  const ov = $('#dov'); if (!ov) return;
  const host = overlayHost(); const id = S.sheet.id;
  const s = srcRect(host, id); const flip = $('.flip', ov);
  ov.classList.remove('open');
  flip.style.height = geo().ch + 'px';
  if (s) { flip.style.top = s.top + 'px'; flip.style.left = s.left + 'px'; }
  later(() => {
    if (s) s.el.style.visibility = '';
    ov.remove(); S.sheet = null; syncURL();
    if (typeof after === 'function') after();
  }, DUR());
}
export function openConfirm(id) {
  const c = cardById(id); S.confirm = c.id;
  const box = document.createElement('div'); box.id = 'confirm';
  if (ios()) {
    box.innerHTML = `<div class="alertdim"></div><div class="alert" role="alertdialog"><div class="at"><b>Delete ${esc(c.name)}?</b><p>Its card goes, and you leave rooms it was shared in.</p></div>
      <div class="ab"><button id="cfNo">Cancel</button><button id="cfYes">Delete</button></div></div>`;
  } else {
    box.innerHTML = `<div class="m-dim on" style="z-index:60"><div class="m-dlg sm" role="alertdialog"><div class="dh"><h3>Delete ${esc(c.name)}?</h3></div>
      <div class="db"><p class="msg">Its card goes, and you leave rooms it was shared in.</p></div>
      <div class="df"><button class="mbtn" id="cfNo">Cancel</button><button class="mbtn danger prim" id="cfYes">Delete</button></div></div></div>`;
  }
  layer().appendChild(box);
  $('#cfNo').addEventListener('click', closeConfirm);
  $('#cfYes').addEventListener('click', () => {
    const id = S.confirm; closeConfirm();
    if (S.sub === id) S.sub = null;
    const ov = $('#dov'); if (ov) ov.remove();
    S.sheet = null; S.renaming = false;
    const gone = cardById(id);
    S.cards = S.cards.filter((x) => x.id !== id);
    S.rooms.forEach((r) => { if (r.sharing === id) r.sharing = null; });
    if (!S.cards.length) S.suggest = true;
    S.active = (S.cards.find((x) => x.kind === 'work') || S.cards[0] || { id: 'suggest' }).id;
    syncWalletCards(); renderChip(true); renderBelow();
    toast(`${gone.name} deleted`);
    syncURL();
  });
}
export function closeConfirm() { $('#confirm')?.remove(); S.confirm = null; }
