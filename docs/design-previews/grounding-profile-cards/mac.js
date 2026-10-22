// Mac: the deck rail, the action column, popovers and the card page.
import { $, $$, esc, clone, reduced, later, ic, bird, S, cardById, activeCard, takenKinds, walletList, ios } from './core.js';
import { KINDS, DESIGNS, MAX_CARDS, BUILT, SOURCES, ME, PEOPLE, RECENT, REFS, REBUILD, CARD_SECTIONS, sectionOf, ctag, SOURCE_READ, SOURCE_TINT } from './data.js';
import { visibleTopics, avatar, chipHTML, renderChip, place, startBuild, layer, closeLayer, showLayer, toast } from './cards.js';
import { roomSub, roomLead, editCardHTML, canCreate, openNew, createCard, hostScale, closeDetail, openConfirm, closeConfirm } from './ios.js';
import { listedRooms, joinRoom, digitsHTML, bindDigits, openCreate, createFormHTML, createDoneHTML, bindCreate } from './rooms.js';
import { syncURL } from './app.js';

// ---------- Mac ----------
// The deck: the cards in an aligned drawer on the left, one action column beside it.
// Home is the cards plus one action column (Pair code, Rooms, Recent). "Open" on the selected card pushes its page.
export const MAC_W = 1400, MAC_H = 820;
export function macCard() { const list = walletList(); return list.find((c) => c.id === S.active) || list[0] || null; }
export function refsOf(c, t) {
  c.refs = c.refs || {};
  if (!c.refs[t]) c.refs[t] = clone(REFS[t] || [[(c.sources || ['Memory'])[0], '16 Oct', 'Notes', `${t} came up in your notes.`]]);
  return c.refs[t];
}
export function renderMac() {
  const contacts = PEOPLE.map((p) => `<button class="m-crow">${avatar(p, 34)}<span class="grow"><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.line)}</div></span></button>`).join('');
  const body = '<div class="mg mg-deck" id="mbody"><div class="deck-rail"><div class="deck" id="tiles"></div></div><div class="mg-act" id="mgAct"></div></div>';
  $('#mac').innerHTML = `
    <nav class="m-rail"><div class="m-lights"><i></i><i></i><i></i></div>
      <span class="m-nav">${ic('message')}</span><span class="m-nav on">${ic('people')}</span><span class="m-nav">${ic('doc')}</span>
      <span class="sp"></span><span class="m-nav">${ic('gear')}</span>${avatar(ME, 30)}</nav>
    <aside class="m-list"><div class="m-listhead"><h2>Contacts</h2></div>
      <div class="m-search">${ic('search')}Search</div>
      <div class="m-clist"><button class="m-crow on"><span class="m-cgtile">${ic('cg')}</span><span class="grow"><div class="nm">Grounding</div><div class="sub">Find what you share</div></span></button>
      <div class="m-gap"></div>${contacts}</div></aside>
    <section class="m-main" id="mmain">
      <header class="m-head"><button class="m-back" id="mBack" aria-label="Back" hidden>${ic('left')}</button><h1 id="mTitle">Grounding</h1><div id="chipwrap" class="chipwrap">${chipHTML()}</div></header>
      ${body}
    </section><div id="layer"></div>`;
  const mb = $('#mbody');
  mb.addEventListener('click', onMacClick);
  mb.addEventListener('dblclick', (e) => { const t = e.target.closest('.scard[data-id]'); if (t && t.dataset.id !== 'suggest') openSub(t.dataset.id); });
  mb.addEventListener('keydown', (e) => {
    if (e.target.id === 'mcName' && e.key === 'Enter') macSaveRename();
    if (e.target.id === 'mcName' && e.key === 'Escape') { S.renaming = false; macRefresh(); }
  });
  mb.addEventListener('focusout', (e) => { if (e.target.id === 'mcName') macSaveRename(); });
  $('#mBack').addEventListener('click', closeSub);
  macRefresh({ instant: true });
}
export function scardInner(c, opts = {}) {
  const n = visibleTopics(c).length;
  const foot = S.building === c.id ? '<i class="spin"></i>Building' : c.suggested ? 'Suggested' : n ? `${n} topics` : 'Not built';
  const open = opts.open && !c.suggested && c.topics.length ? `<span class="sc-open" role="button" aria-label="Open ${esc(c.name)}">Open</span>` : '';
  return `<span class="sc-head"><span class="sc-glyph">${ic(c.kind)}</span><span class="sc-name">${esc(c.name)}</span>${open}</span>
    <span class="sc-focus">${esc(c.focus || '')}</span><span class="sc-foot"><span>${foot}</span>${bird()}</span>`;
}
export function syncTiles(instant) {
  const box = $('#tiles'); if (!box) return;
  const deck = true;
  const list = walletList(); const cur = macCard();
  const have = new Map($$('.scard[data-id]', box).map((el) => [el.dataset.id, el]));
  for (const [id, el] of have) if (!list.some((c) => c.id === id)) el.remove();
  let plus = $('#tplus', box);
  if (!plus) {
    plus = document.createElement('button');
    plus.id = 'tplus'; plus.className = 'scard ghost'; plus.setAttribute('aria-label', 'New card');
    plus.innerHTML = ic('plus') + (deck ? '<span>New card</span>' : '');
    box.appendChild(plus);
  }
  list.forEach((c) => {
    let el = have.get(c.id);
    if (!el) {
      el = document.createElement('button');
      el.className = 'scard'; el.dataset.id = c.id;
      if (!instant) { el.style.opacity = '0'; if (deck) el.style.transform = plus.style.transform; }
      box.insertBefore(el, plus);
      void el.offsetWidth;
      el.style.opacity = '';
    } else box.insertBefore(el, plus);
    const on = cur && c.id === cur.id;
    el.dataset.kind = c.kind;
    el.innerHTML = scardInner(c, { open: on });
    el.classList.toggle('is-active', Boolean(on));
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', `${c.name} card`);
  });
  plus.hidden = S.cards.length >= MAX_CARDS;
  if (instant) box.classList.add('instant');
  if (deck) layoutDeck();
  if (instant) { void box.offsetWidth; box.classList.remove('instant'); }
}
// Deck rail: one aligned column. Stacked tiles show a 40px header strip and tuck 8px under the next;
// the selected tile opens to full height in place and pushes the rest down.
export function layoutDeck() {
  const box = $('#tiles'); const list = walletList(); const cur = macCard();
  const FULL = 110, STRIP = 48, STEP = 40, RING = 12;
  let y = 0;
  list.forEach((c, i) => {
    const el = box.querySelector(`.scard[data-id="${c.id}"]`); if (!el) return;
    const on = cur && c.id === cur.id; const lastTile = i === list.length - 1;
    el.style.transform = `translate3d(0, ${y}px, 0)`;
    el.style.height = (on ? FULL : lastTile ? STEP : STRIP) + 'px';
    el.style.zIndex = String(i + 1);
    y += on ? FULL + RING : STEP;
  });
  const lastOn = list.length && cur && list[list.length - 1].id === cur.id;
  y = list.length ? y + (lastOn ? 0 : 12) : 0;
  const plus = $('#tplus', box);
  plus.style.transform = `translate3d(0, ${y}px, 0)`;
  box.style.height = (plus.hidden ? y : y + 40) + 'px';
}
export function buildBlock(c) {
  return `<div class="mc-empty"><span class="mc-emptycard" data-kind="${c.kind}"><span class="sc-glyph">${ic(c.kind)}</span></span><h2>${esc(c.name)}</h2><p>Your agent writes it</p><button class="mbtn prim" data-build="${esc(c.id)}">Build</button></div>`;
}
export function roomRowMac(r) {
  const trail = r.open ? `<span class="chev">${ic('chev')}</span>` : '';
  return `<div class="m-row room${r.open ? '' : ' closed'}" data-roomrow="${r.id}">${roomLead(r)}<span class="grow"><div class="tt">${esc(r.name)}</div><div class="sub">${esc(roomSub(r))}</div></span>${trail}</div>`;
}
export function pendingHTML() {
  const r = S.pending && S.rooms.find((x) => x.id === S.pending); const c = activeCard();
  if (!r || !c) return '';
  const sugg = S.cards.find((x) => x.kind === r.kind && x.topics.length);
  const chip = sugg && sugg.id !== c.id ? `<button class="sugchip" id="pcSugg" title="Share ${esc(sugg.name)} and join"><span class="mini" data-kind="${sugg.kind}"></span>Suggested: ${esc(sugg.name)}</button>` : '';
  return `<div class="pc-confirm"><span class="grow"><div class="tt">${esc(r.name)}</div><div class="sub">${esc(KINDS[r.kind].label)} · ${r.people} people</div></span>${chip}<button class="mbtn tint" id="pcJoin" title="Join sharing ${esc(c.name)}"><span class="mini" data-kind="${c.kind}"></span>Join</button></div>`;
}
export function homeHTML() {
  const c = activeCard();
  return `<div class="mg-actin">
    <div class="m-panel pcpanel"><div class="m-row pcrow"><span class="icon">${ic('hash')}</span><span class="grow"><div class="tt">Pair code</div></span>${digitsHTML(!(c && c.topics.length))}<button class="mbtn" id="pcCreate" ${c && c.topics.length ? '' : 'disabled'}>Create</button></div>
      ${S.codeErr ? `<div class="pcerr">${esc(S.codeErr)}</div>` : ''}${pendingHTML()}</div>
    <div class="m-sec">Rooms</div><div class="m-panel">${listedRooms().map(roomRowMac).join('')}</div>
    <div class="m-sec">Recent</div><div class="m-panel">${RECENT.filter((r) => cardById(r.card)).map((r) => `<button class="m-row">${avatar(r.p, 30)}<span class="grow"><div class="tt">${esc(r.p.name)}</div><div class="sub">${esc(cardById(r.card).name)} · ${r.common} in common</div></span><span class="chev">${ic('chev')}</span></button>`).join('')}</div>
    ${c && c.topics.length ? `<div class="m-sec">Your card</div><div class="m-panel yc"><button class="m-row" id="ycOpen" aria-label="Open ${esc(c.name)}"><span class="mini" data-kind="${c.kind}"></span><span class="grow"><div class="tt">${esc(c.name)}</div></span><span class="chev">${ic('chev')}</span></button>
      <div class="yc-tags">${c.topics.map((t) => ctag(t, c.hidden.includes(t))).join('')}</div></div>` : ''}
  </div>`;
}
export function subHTML(c) {
  const rb = S.rebuilding === c.id;
  const off = S.srcOff || {};
  const fresh = S.fresh && S.fresh.card === c.id ? S.fresh : {};
  const lineHTML = (t) => {
    const hidden = c.hidden.includes(t);
    const rows = refsOf(c, t);
    const first = rows[rows.length - 1][1], last = rows[0][1];
    const seen = first === last ? `Seen ${first}` : `First seen ${first} · Last seen ${last}`;
    const refs = rows.map(([src, date, title, snip], k) => `<div class="ln-ref${off[c.id + ':' + src] ? ' off' : ''}${fresh.ref === t && k === 0 ? ' changed' : ''}"><span class="ln-ic" style="--src:${SOURCE_TINT[src] || 'var(--tint)'}">${ic(SOURCES[src] || 'note')}</span><span class="ln-body"><span class="ln-title">${esc(title)}</span><span class="ln-snip">${esc(src)} · ${esc(snip)}</span></span><span class="ln-date">${esc(date)}</span></div>`).join('');
    return `<div class="ln-group${hidden ? ' off' : ''}${fresh.line === t ? ' fresh' : ''}"><div class="ln-head">${ctag(t, hidden)}${fresh.line === t ? '<em class="newb">New</em>' : ''}<span class="ln-seen">${esc(seen)}</span><button class="mc-hide" data-t="${esc(t)}" aria-pressed="${hidden}">${ic(hidden ? 'eye' : 'eyeOff')}${hidden ? 'Show' : 'Hide'}</button></div><div class="ln-refs">${refs}</div></div>`;
  };
  const sections = CARD_SECTIONS.map((name) => {
    const ts = c.topics.filter((t) => sectionOf(c, t) === name);
    return ts.length ? `<div class="m-sec">${name}</div><div class="m-panel sp-lines${rb ? ' dim' : ''}">${ts.map(lineHTML).join('')}</div>` : '';
  }).join('');
  const sources = (c.sources || []).map((src) => {
    const on = !off[c.id + ':' + src];
    return `<div class="m-row src"><span class="icon" style="background:${SOURCE_TINT[src] || 'var(--tint)'}">${ic(SOURCES[src] || 'note')}</span><span class="grow"><div class="tt">${esc(src)}</div><div class="sub">Read ${esc(rb ? 'just now' : SOURCE_READ[src] || 'today')}</div></span><button class="msw" role="switch" aria-checked="${on}" aria-label="${esc(src)}" data-src="${esc(src)}"></button></div>`;
  }).join('');
  const sharing = c.sharingOff ? 'false' : 'true';
  return `<div class="sp">
    <div class="sp-head">
      <span class="sp-glyph" data-kind="${c.kind}">${ic(c.kind)}</span>
      <div class="sp-title">${S.renaming ? `<input class="mc-name" id="mcName" value="${esc(c.name)}" maxlength="40" aria-label="Name">` : `<h2>${esc(c.name)}</h2>`}<div class="sp-focus">${esc([c.focus, `${c.topics.length} lines`, `built ${c.built || '14 Oct'}`].filter(Boolean).join(' · '))}</div></div>
      <button class="mbtn ghost" data-act="rename">${ic('pencil')}Rename</button><button class="mbtn ghost danger" data-act="delete">${ic('trash')}Delete</button>
      <button class="mbtn prim" id="spRebuild" ${rb ? 'disabled' : ''}>${rb ? '<i class="spin"></i>Rebuilding' : ic('memory') + 'Rebuild from memory'}</button>
    </div>
    <div class="sp-progress${rb ? ' on' : ''}"><i></i></div>
    ${sections}
    <div class="m-sec">Sources</div>
    <div class="m-panel sp-src">${sources}</div>
    <div class="m-panel sp-share"><div class="m-row"><span class="grow"><div class="tt">Share my card</div></span><button class="msw" role="switch" aria-checked="${sharing}" aria-label="Share my card" data-share="1"></button></div></div>
  </div>`;
}
export function macRefresh(opts = {}) {
  if (!$('#mbody')) return;
  syncTiles(opts.instant);
  const c = macCard();
  const first = !S.cards.length;
  const sub = S.sub && cardById(S.sub);
  if (S.sub && !sub) S.sub = null;
  $('#mbody').classList.toggle('first-run', first);
  $('#mbody').classList.toggle('in-sub', Boolean(sub));
  $('#mBack').hidden = !sub;
  $('#mTitle').textContent = sub ? sub.name : 'Grounding';
  const act = $('#mgAct');
  act.classList.toggle('sub', Boolean(sub));
  act.innerHTML = first ? (c ? buildBlock(c) : '') : sub ? subHTML(sub) : homeHTML();
  if (!first && !sub) bindDigits(act);
  if (opts.push && !reduced.matches) { act.classList.remove('push', 'pop'); void act.offsetWidth; act.classList.add(opts.push); }
  if (S.renaming) { const inp = $('#mcName'); if (inp) { inp.focus(); inp.select(); } }
}
export function openSub(id) {
  if (!cardById(id) || !cardById(id).topics.length) return;
  S.active = id; S.sub = id; S.renaming = false; S.lastJump = null;
  renderChip(true); macRefresh({ push: 'push' }); syncURL();
  $('#mgAct').scrollTop = 0;
}
export function closeSub() {
  S.sub = null; S.renaming = false; S.fresh = null; S.lastJump = null;
  macRefresh({ push: 'pop' }); syncURL();
}
export function macSelect(id) {
  if (id === 'suggest' || id === S.active) return;
  S.active = id; S.renaming = false; S.lastJump = null;
  if (S.sub) S.sub = cardById(id).topics.length ? id : null;
  S.fresh = null;
  renderChip(true); macRefresh(); syncURL();
}
export function macJoinPending() {
  const r = S.pending && S.rooms.find((x) => x.id === S.pending); const c = activeCard();
  if (!r || !c) return;
  joinRoom(r, c); S.lastJump = null;
  macRefresh(); syncURL();
  toast(`Sharing ${c.name} in ${r.name}`);
}
export function onMacClick(e) {
  const t = e.target;
  const build = t.closest('[data-build]'); if (build) { startBuild(build.dataset.build); return; }
  if (t.closest('#tplus')) { openNew(); return; }
  const open = t.closest('.sc-open'); if (open) { openSub(open.closest('.scard').dataset.id); return; }
  const tile = t.closest('.scard[data-id]'); if (tile) { macSelect(tile.dataset.id); return; }
  const hide = t.closest('.mc-hide');
  if (hide) {
    const c = cardById(S.sub) || activeCard(); const name = hide.dataset.t;
    c.hidden = c.hidden.includes(name) ? c.hidden.filter((x) => x !== name) : c.hidden.concat(name);
    S.lastJump = null; macRefresh(); syncURL();
    $(`.mc-hide[data-t="${CSS.escape(name)}"]`)?.focus();
    return;
  }
  if (t.closest('#ycOpen')) { openSub(S.active); return; }
  const shareSw = t.closest('[data-share]'); if (shareSw) { const c = cardById(S.sub); c.sharingOff = !c.sharingOff; macRefresh(); return; }
  const sw = t.closest('.msw');
  if (sw) { S.srcOff = S.srcOff || {}; const k = S.sub + ':' + sw.dataset.src; S.srcOff[k] = !S.srcOff[k]; macRefresh(); return; }
  if (t.closest('#spRebuild')) { macRebuild(S.sub); return; }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'rename') { S.renaming = true; macRefresh(); return; }
  if (act === 'delete') { openConfirm(S.sub || activeCard().id); return; }
  if (t.closest('#pcCreate')) { openCreate(S.active, { anchor: t.closest('#pcCreate') }); return; }
  if (t.closest('#pcJoin')) { macJoinPending(); return; }
  if (t.closest('#pcSugg')) {
    const r = S.rooms.find((x) => x.id === S.pending);
    const c = S.cards.find((x) => x.kind === r.kind && x.topics.length);
    if (c) macSelect(c.id);
    later(() => macJoinPending(), reduced.matches ? 0 : 260);
  }
}
export function macSaveRename() {
  if (!S.renaming) return;
  const c = cardById(S.sub) || activeCard(); const v = $('#mcName')?.value.trim();
  if (v) c.name = v;
  S.renaming = false;
  renderChip(); macRefresh();
}
export function macRebuild(id) {
  const c = cardById(id); if (!c || S.rebuilding) return;
  S.rebuilding = id; S.lastJump = null; macRefresh(); syncURL();
  later(() => {
    S.rebuilding = null;
    const plan = REBUILD[c.kind === 'work' ? 'work' : ''] || { line: 'Weekly planning', ref: [(c.sources || ['Memory'])[0], 'Today', 'Notes', 'Planned the week ahead.'], change: null };
    const first = c.topics[0];
    if (!c.topics.includes(plan.line)) { c.topics.push(plan.line); c.sec = Object.assign({}, c.sec, { [plan.line]: 'Interests' }); refsOf(c, plan.line); c.refs[plan.line] = [plan.ref]; }
    if (first) { const r = refsOf(c, first); r[0] = plan.change || [r[0][0], 'Today', r[0][2], r[0][3]]; }
    c.built = 'today';
    S.fresh = { card: c.id, line: plan.line, ref: first };
    macRefresh(); syncTiles();
  }, reduced.matches ? 300 : 2000);
}
export function macBuild(id) {
  if (id === 'suggest') {
    S.cards = [{ id: 'work', kind: 'work', name: 'Work', focus: '', topics: [], hidden: [], sources: ['Memory', 'Papers', 'Calendar'] }];
    S.suggest = false; S.active = 'work'; id = 'work';
    const el = $('#tiles .scard[data-id="suggest"]'); if (el) el.dataset.id = 'work';
  }
  S.building = id; S.lastJump = null;
  renderChip(true); macRefresh(); syncURL();
  later(() => {
    const c = cardById(id); if (!c) return;
    c.topics = BUILT[c.kind].slice();
    if (c.kind === 'work' && !c.focus) c.focus = 'Memory for long-horizon agents';
    S.building = null;
    macRefresh({ pop: true });
  }, reduced.matches ? 300 : 1500);
}

export function createMac() {
  const sh = S.sheet;
  sh.anchor = sh.anchor || $('#pcCreate');
  showLayer(`<div class="m-popcatch" id="dim"></div><div class="m-pop createpop" id="mpop" role="dialog" aria-label="Create a code"></div>`, (l) => {
    $('#dim', l).addEventListener('click', () => closeLayer());
    bindCreate(l);
  });
  paintCreateMac();
}
export function paintCreateMac(swap) {
  const sh = S.sheet; const pop = $('#mpop'); if (!pop) return;
  if (sh.step === 'done') pop.innerHTML = `${createDoneHTML()}<button class="mbtn wide" id="cfShare">${ic('share')}Share this code</button>`;
  else {
    const focused = document.activeElement && document.activeElement.id === 'cfName';
    pop.innerHTML = `<div class="pop-h"><b>Create a code</b></div><input class="cf-name" id="cfName" placeholder="Meetup name" maxlength="80" value="${esc(sh.name)}" aria-label="Meetup name" autocomplete="off">${createFormHTML()}<div class="cf-foot"><button class="mbtn prim" id="cfGo" ${sh.name.trim() ? '' : 'disabled'}>Create</button></div>`;
    if (focused) $('#cfName').focus();
  }
  if (swap && !reduced.matches) { pop.classList.remove('swapin'); void pop.offsetWidth; pop.classList.add('swapin'); }
  placePop();
}
export function placePop() {
  const pop = $('#mpop'); if (!pop || !S.sheet) return;
  if (!S.sheet.anchor || !S.sheet.anchor.isConnected) S.sheet.anchor = $('#pcCreate');
  const a = S.sheet.anchor; if (!a) return;
  const mac = $('#mac'); const k = hostScale(mac);
  const mr = mac.getBoundingClientRect(); const ar = a.getBoundingClientRect();
  const ax = (ar.left - mr.left) / k, ay = (ar.top - mr.top) / k, aw = ar.width / k, ah = ar.height / k;
  const W = pop.offsetWidth, H = pop.offsetHeight;
  const left = Math.max(16, Math.min(MAC_W - W - 16, ax + aw - W));
  let top = ay + ah + 10; let up = false;
  if (top + H > MAC_H - 16) { top = Math.max(16, ay - H - 10); up = true; }
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.classList.toggle('up', up);
}

// New card: one compact dialog, swatches above a live card.
export function macNew(opts) {
  const sh = S.sheet;
  showLayer(`<div class="m-dim" id="dim"><div class="m-dlg nc" role="dialog" aria-label="New card">
      <div class="dh"><h3>New card</h3><button class="m-x" id="nX" aria-label="Close">${ic('close')}</button></div>
      <div class="db"><div class="swatches" role="radiogroup" aria-label="Design">${DESIGNS.map((k, i) => `<button class="swatch${i === sh.idx ? ' on' : ''}${takenKinds().includes(k) ? ' taken' : ''}" data-kind="${k}" data-i="${i}" role="radio" aria-checked="${i === sh.idx}" aria-label="${esc(KINDS[k].label)}" title="${esc(KINDS[k].label)}">${ic(k)}</button>`).join('')}</div>
        <div class="swlabel" id="swlabel"></div>
        <div class="ncprev" id="ncprev"></div></div>
      <div class="df"><button class="mbtn" id="nCancel">Cancel</button><button class="mbtn prim" id="nGo">Create</button></div></div></div>`, (l) => {
    $('#nX', l).addEventListener('click', () => closeLayer());
    $('#nCancel', l).addEventListener('click', () => closeLayer());
    $('#dim', l).addEventListener('click', (e) => { if (e.target.id === 'dim') closeLayer(); });
    $$('.swatch', l).forEach((b) => b.addEventListener('click', () => { S.sheet.idx = Number(b.dataset.i); paintNew(true); }));
    l.addEventListener('input', (e) => { const f = e.target.dataset.f; if (!f) return; S.sheet[f] = e.target.value; $('#nGo').disabled = !canCreate(); });
    l.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset.f && canCreate()) createCard();
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.classList.contains('swatch')) {
        const i = Math.max(0, Math.min(DESIGNS.length - 1, S.sheet.idx + (e.key === 'ArrowRight' ? 1 : -1)));
        S.sheet.idx = i; paintNew(true); $(`.swatch[data-i="${i}"]`).focus();
      }
    });
    $('#nGo', l).addEventListener('click', createCard);
  });
  paintNew(false, opts && opts.instant);
}
export function paintNew(swap, noFocus) {
  const sh = S.sheet; const kind = DESIGNS[sh.idx];
  $$('.swatch').forEach((b, i) => { b.classList.toggle('on', i === sh.idx); b.setAttribute('aria-checked', String(i === sh.idx)); });
  const taken = takenKinds().includes(kind);
  $('#swlabel').textContent = KINDS[kind].label + (taken ? ' · in your wallet' : '');
  const prev = $('#ncprev');
  prev.innerHTML = editCardHTML(sh.idx, sh);
  if (swap && !reduced.matches) { prev.classList.remove('swapin'); void prev.offsetWidth; prev.classList.add('swapin'); }
  $('#nGo').disabled = !canCreate();
  if (!noFocus && !taken && !swap) $('#ncprev input[data-f="name"]')?.focus();
}

document.addEventListener('keydown', (e) => {
  if (!S) return;
  if (e.key === 'Escape') {
    if (S.confirm) closeConfirm();
    else if (S.sheet && S.sheet.type === 'detail') closeDetail();
    else if (S.sheet) closeLayer();
    else if (!ios() && S.sub && !S.renaming) closeSub();
  }
});
