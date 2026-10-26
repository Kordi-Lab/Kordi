// Mac: the Grounding page in Contacts. Home with the Nearby row, the Nearby column, the person page.
import { $, esc, ic, bird, spinner, S, cardById } from './core.js';
import { ME, CARDS, ROOMS, RECENT, OPEN_TO, band, rangePill, scorePill, perDay, needSub, listPeople, matchingCount, personById, MATCH } from './data.js';
import { nearbyValue, requestsHTML, toneOf } from './ios.js';
import { openMacLayer, renderMacLayer } from './mac-layers.js';
import { syncURL } from './app.js';

export const MAC_W = 1400, MAC_H = 820;
const av = (p, size, cls = '') => `<span class="k-av ${cls}" style="--s:${size}px">${esc(p.initials)}</span>`;
const chev = () => `<span class="k-chev">${ic('chev')}</span>`;
const sw = (kind, cls = '') => `<span class="k-sw ${cls}" data-kind="${kind}"></span>`;
export const ksw = (on, attrs = '') => `<button class="k-switch" role="switch" aria-checked="${on}" ${attrs}><i></i></button>`;
const ctag = (t) => `<span class="k-tag sm" style="--tone:${toneOf(t)}"><i></i>${esc(t)}</span>`;

// ---------- frame ----------
export function renderMac() {
  const contacts = RECENT.map((p) => `<button class="k-crow">${av(p, 34)}<span class="grow"><span class="nm">${esc(p.name)}</span><span class="sub">${esc(p.line)}</span></span></button>`).join('');
  $('#mac').innerHTML = `
    <nav class="k-rail"><div class="k-lights"><i></i><i></i><i></i></div>
      <span class="k-nav">${ic('message')}</span><span class="k-nav on">${ic('people')}</span><span class="k-nav">${ic('doc')}</span>
      <span class="sp"></span><span class="k-nav">${ic('gear')}</span>${av(ME, 30)}</nav>
    <aside class="k-list"><div class="k-listhead"><h2>Contacts</h2></div><div class="k-search">${ic('search')}Search</div>
      <div class="k-clist"><button class="k-crow on"><span class="k-cgtile icn" data-hue="pink">${ic('cg')}</span><span class="grow"><span class="nm">Grounding</span><span class="sub">Match. Meet. Build.</span></span></button><div class="k-gap"></div>${contacts}</div></aside>
    <section class="k-main" id="kmain"></section><div id="mlayer"></div>`;
  renderMain();
  bindMac();
}

// ---------- wallet shell: header, deck rail, one 540 px column ----------
function deckHTML() {
  const FULL = 110, STRIP = 48, STEP = 40, RING = 12;
  let y = 0;
  const tiles = CARDS.map((c, i) => {
    const on = c.id === 'work'; const last = i === CARDS.length - 1;
    const h = on ? FULL : last ? STEP : STRIP;
    const html = `<div class="scard${on ? ' is-on' : ''}" data-kind="${c.kind}" style="transform:translate3d(0,${y}px,0);height:${h}px;z-index:${i + 1}"><span class="sc-head"><span class="sc-glyph">${ic(c.kind)}</span><span class="sc-name">${esc(c.name)}</span></span><span class="sc-owner">${esc(ME.name)}</span><span class="sc-focus">${esc(c.focus)}</span><span class="sc-foot"><span>${c.topics.length} topics</span>${bird()}</span></div>`;
    y += on ? FULL + RING : STEP;
    return html;
  }).join('');
  y += 12;
  return `<nav class="k-deckrail" aria-label="Cards"><div class="k-deck" style="height:${y + 40}px">${tiles}<button class="k-decknew" style="transform:translate3d(0,${y}px,0)">${ic('plus')}New card</button></div></nav>`;
}
function shell(title, col, opts = {}) {
  const c = cardById(opts.chipCard || 'work');
  const chip = opts.chipMenu
    ? `<button class="k-sharechip is-menu" id="mChip" aria-haspopup="menu">${sw(c.kind, 'chip')}<span>Sharing: <b>${esc(c.name)}</b></span>${ic('down')}</button>`
    : `<span class="k-sharechip">${sw(c.kind, 'chip')}<span>Sharing: <b>${esc(c.name)}</b></span></span>`;
  return `<header class="k-head">${opts.back ? `<button class="k-iconbtn back" id="mBack" aria-label="Back">${ic('left')}</button>` : ''}<h1>${esc(title)}</h1>${chip}${opts.more ? `<button class="k-iconbtn" id="mMore" aria-label="More" aria-haspopup="menu">${ic('more')}</button>` : ''}</header>
    <div class="k-body">${deckHTML()}<div class="k-wmain"><div class="k-col${opts.push ? ' is-push' : ''}${opts.center ? ' is-center' : ''}">${col}</div></div></div>`;
}

// ---------- Home ----------
function macNearbySub() {
  const v = nearbyValue();
  if (!S.nb.on || S.nb.paused) return v;
  if (!S.nb.phone) return 'No location from your iPhone';
  return `${v} · from your iPhone`;
}
function homeCol() {
  const c = cardById('work');
  const digits = `<span class="k-digits">${'<span></span>'.repeat(4)}</span>`;
  const rooms = ROOMS.map((r, i) => `<button class="k-mrow${i === 1 ? ' closed' : ''}">${sw(i === 0 ? 'workshop' : 'work')}<span class="k-mtext"><span class="k-mtitle">${esc(r.name)}</span><span class="k-msub">${esc(r.sub)}</span></span>${i === 0 ? chev() : ''}</button>`).join('');
  const recent = RECENT.map((p) => `<button class="k-mrow">${av(p, 30)}<span class="k-mtext"><span class="k-mtitle">${esc(p.name)}</span><span class="k-msub">${esc(p.line)}</span></span><span class="k-trail">${p.score}%</span>${chev()}</button>`).join('');
  return `<h2 class="k-msec first">Your card</h2>
    <div class="k-panel"><button class="k-mrow">${sw(c.kind)}<span class="k-mtext"><span class="k-mtitle">${esc(c.name)}</span></span>${chev()}</button><div class="k-ytags">${c.topics.map(ctag).join('')}</div></div>
    <div class="k-panel k-paircode">
      <button class="k-pair-row">${'<span class="k-ptile icn" data-hue="violet">' + ic('phones') + '</span>'}<span class="k-ptitle">Pair</span>${chev()}</button>
      <div class="k-pair-row">${'<span class="k-ptile icn" data-hue="cyan">' + ic('hash') + '</span>'}<span class="k-ptitle">Pair code</span>${digits}<button class="k-mbtn">Create</button></div>
      <button class="k-pair-row" id="mNearbyRow"><span class="k-ptile icn" data-hue="amber">${ic('pin')}</span><span class="k-mtext"><span class="k-ptitle">Nearby</span><span class="k-msub">${esc(macNearbySub())}</span></span>${chev()}</button>
    </div>
    <h2 class="k-msec">Rooms</h2><div class="k-panel">${rooms}</div>
    <h2 class="k-msec">Recent</h2><div class="k-panel">${recent}</div>`;
}

// ---------- Nearby ----------
function statusLine() {
  const nb = S.nb;
  if (nb.paused) return `<div class="k-status">Paused until ${esc(nb.paused)}<button class="k-link" id="mResume">Resume</button></div>`;
  if (!nb.phone) return '<div class="k-status">Open Kordi on your iPhone to update your location.</div>';
  return '<div class="k-status">From your iPhone · 3 min ago</div>';
}
function personRowMac(p) {
  const tags = p.met.map((n) => `<span class="k-mtag">${ic('check')}${esc(n.label)}</span>`).join('');
  return `<button class="k-mrow person" data-mperson="${p.id}">${av(p, 30)}<span class="k-mtext"><span class="k-mtitle">${esc(p.name)}${tags}</span><span class="k-msub">${p.score}% · ${esc(band(p.m))} · ${esc(p.headline)}</span></span>${chev()}</button>`;
}
function nearbyCol() {
  const nb = S.nb;
  const all = OPEN_TO.concat(nb.openTo.filter((x) => !OPEN_TO.includes(x)));
  const chips = all.map((t) => { const on = nb.openTo.includes(t); return `<button class="k-chip${on ? ' on' : ''}" data-mopen="${esc(t)}" aria-pressed="${on}">${on ? ic('check') : ''}${esc(t)}</button>`; }).join('');
  const add = S.draft != null ? `<span class="k-chip draft"><input id="mOpenDraft" maxlength="30" placeholder="Open to" value="${esc(S.draft)}" aria-label="Open to"></span>` : `<button class="k-chip add" id="mOpenAdd" aria-label="Add" ${nb.openTo.length >= 5 ? 'disabled' : ''}>${ic('plus')}</button>`;
  let people = '';
  if (!nb.paused && nb.phone) {
    const list = listPeople(nb, S.needs); const more = matchingCount(nb);
    const rows = list.map(personRowMac).join('') + (more ? `<div class="k-mrow matching"><span class="k-spinbox">${spinner()}</span><span class="k-mtext"><span class="k-msub">Matching ${more} more</span></span></div>` : '');
    people = `<div class="k-msec-row"><h2 class="k-msec">People</h2><span class="k-pills"><button class="k-mbtn sm" id="mRange" aria-haspopup="menu">${esc(rangePill(nb.range))}${ic('down')}</button><button class="k-mbtn sm" id="mScore" aria-haspopup="menu">${esc(scorePill(nb.min))}${ic('down')}</button></span></div>
      <div class="k-panel">${rows || '<div class="k-mrow plain"><span class="k-mtext"><span class="k-msub">No one nearby yet</span></span></div>'}</div>`;
  }
  const needs = S.needs.map((n) => `<button class="k-mrow plain${n.ended ? ' ended' : ''}" data-mneed="${n.id}"><span class="k-mtext"><span class="k-mtitle">${esc(n.text)}</span><span class="k-msub">${esc(needSub(n))}</span></span>${chev()}</button>`).join('');
  const a = nb.alerts;
  return `${statusLine()}
    <h2 class="k-msec">Open to</h2><div class="k-panel k-chips">${chips}${add}</div>
    ${people}
    <h2 class="k-msec">Looking for</h2><div class="k-panel">${needs}<button class="k-mrow plain k-addrow" id="mNeedAdd">${ic('plus')}Add</button></div>
    <h2 class="k-msec">Alerts</h2><div class="k-panel">
      <div class="k-mrow plain"><span class="k-mtext"><span class="k-mtitle">Requests</span></span>${ksw(a.requests, 'data-malert="requests" aria-label="Requests"')}</div>
      <div class="k-mrow plain"><span class="k-mtext"><span class="k-mtitle">Good matches</span><span class="k-msub">85% and up</span></span>${ksw(a.matches, 'data-malert="matches" aria-label="Good matches"')}</div>
      <div class="k-mrow plain"><span class="k-mtext"><span class="k-mtitle">At most</span><span class="k-msub">Alerts go to your iPhone</span></span><button class="k-mbtn sm" id="mPerDay" aria-haspopup="menu">${esc(perDay(a.max))}${ic('down')}</button></div>
    </div>`;
}
function offCol() {
  return `<div class="k-off"><span class="k-offmark">${ic('pin')}</span><h2>Nearby</h2><p>See people near you who share a card.</p><button class="k-mbtn prim" id="mTurnOn">Turn on</button></div>`;
}

// ---------- person ----------
function personPage() {
  const p = personById(S.person); const added = S.added[p.id];
  const rows = (items) => items.map((r) => `<div class="k-row"><span class="k-dot" style="--tone:var(--t-${r.tone})"><i></i></span><span class="k-rtext"><span class="k-rtitle">${esc(r.topic)}</span><span class="k-rsub">${esc(r.why)}</span></span></div>`).join('');
  const reqs = requestsHTML(p.id, true);
  const tab = S.tab;
  const body = tab === 'shared'
    ? `<section class="k-section"><div class="k-group">${rows(MATCH.shared)}</div></section>`
    : `<section class="k-section"><h2 class="k-stitle">You bring</h2><div class="k-group">${rows(MATCH.youBring)}</div></section><section class="k-section"><h2 class="k-stitle">${esc(p.name.split(' ')[0])} brings</h2><div class="k-group">${rows(MATCH.theyBring)}</div></section>`;
  return `<div class="k-scroll"><div class="k-pbody">
    <button class="k-back" id="mPBack">${ic('left')}Back</button>
    <div class="k-hero"><span class="k-pairav">${av(ME, 64, 'ring')}${av(p, 64, 'ring')}</span><span class="k-badge">${p.score}%</span><h1>${esc(p.name)}</h1>
      <div class="k-hero-line"><span class="k-pchip">${sw(p.profile.kind, 'chip')}${esc(p.profile.name)}</span><span>${esc(band(p.m))}</span></div></div>
    <div class="k-tiles"><button class="k-tile primary" id="mAdd" ${added ? 'disabled' : ''}>${ic(added ? 'clock' : 'userPlus')}<span>${added ? 'Requested' : 'Add'}</span></button><button class="k-tile" disabled>${ic('calendar')}<span>Meet</span></button><button class="k-tile" disabled>${ic('message')}<span>Chat</span></button></div>
    ${reqs ? `<section class="k-section"><h2 class="k-stitle">Your requests</h2><div class="k-group">${reqs}</div></section>` : ''}
    <div class="k-seg" role="tablist" aria-label="Match"><button role="tab" data-mtab="shared" aria-selected="${tab === 'shared'}">Shared</button><button role="tab" data-mtab="trade" aria-selected="${tab === 'trade'}">Trade</button></div>
    ${body}
  </div></div>`;
}

// ---------- render and wire ----------
export function renderMain() {
  const main = $('#kmain'); if (!main) return;
  const scroller = $('.k-wmain', main) || $('.k-scroll', main); const top = scroller ? scroller.scrollTop : 0;
  const keep = S.keepScroll === S.page;
  let html;
  if (S.page === 'person') html = personPage();
  else if (S.page === 'home') html = shell('Grounding', homeCol());
  else if (S.page === 'off') html = shell('Nearby', offCol(), { back: true, push: !keep, center: true });
  else html = shell('Nearby', nearbyCol(), { back: true, more: true, chipMenu: true, chipCard: S.nb.card, push: !keep });
  main.innerHTML = html;
  main.classList.toggle('is-person', S.page === 'person');
  const sc = $('.k-wmain', main) || $('.k-scroll', main);
  if (keep && sc) sc.scrollTop = top;
  S.keepScroll = S.page;
  if (S.layer) renderMacLayer(true);
  if (S.draft != null) { const d = $('#mOpenDraft'); if (d) { d.focus(); d.setSelectionRange(d.value.length, d.value.length); } }
}
export function mgo(pageName, opts = {}) {
  S.page = pageName; S.layer = null;
  if (!opts.keep) { S.keepScroll = null; S.draft = null; }
  $('#mlayer').innerHTML = '';
  renderMain(); syncURL();
}
function bindMac() {
  const mac = $('#mac');
  if (mac.dataset.bound) return;
  mac.dataset.bound = '1';
  mac.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#mlayer')) return;
    const nb = S.nb;
    if (t.closest('#mNearbyRow')) { mgo(nb.on ? 'nearby' : 'off'); return; }
    if (t.closest('#mBack')) { mgo('home'); return; }
    if (t.closest('#mPBack')) { mgo('nearby'); return; }
    if (t.closest('#mTurnOn')) { openMacLayer({ type: 'consent' }); return; }
    if (t.closest('#mMore')) { openMacLayer({ type: 'menu', menu: 'more', anchor: '#mMore' }); return; }
    if (t.closest('#mChip')) { openMacLayer({ type: 'menu', menu: 'card', anchor: '#mChip' }); return; }
    if (t.closest('#mRange')) { openMacLayer({ type: 'menu', menu: 'range', anchor: '#mRange' }); return; }
    if (t.closest('#mScore')) { openMacLayer({ type: 'menu', menu: 'score', anchor: '#mScore' }); return; }
    if (t.closest('#mPerDay')) { openMacLayer({ type: 'menu', menu: 'perday', anchor: '#mPerDay' }); return; }
    if (t.closest('#mNeedAdd')) { openMacLayer({ type: 'request', id: null }); return; }
    if (t.closest('#mResume')) { nb.paused = null; S.clock = '3:41'; mgo('nearby', { keep: true }); return; }
    if (t.closest('#mAdd')) { S.added[S.person] = true; mgo('person', { keep: true }); return; }
    if (t.closest('#mOpenAdd')) { S.draft = ''; mgo('nearby', { keep: true }); return; }
    const chip = t.closest('[data-mopen]');
    if (chip) { const v = chip.dataset.mopen; const l = nb.openTo; nb.openTo = l.includes(v) ? l.filter((x) => x !== v) : l.length < 5 ? l.concat(v) : l; mgo('nearby', { keep: true }); return; }
    const swt = t.closest('[data-malert]');
    if (swt) { const k = swt.dataset.malert; nb.alerts[k] = !nb.alerts[k]; swt.setAttribute('aria-checked', String(nb.alerts[k])); return; }
    const pr = t.closest('[data-mperson]'); if (pr) { S.person = pr.dataset.mperson; S.tab = 'shared'; mgo('person'); return; }
    const nd = t.closest('[data-mneed]'); if (nd) { openMacLayer({ type: 'request', id: nd.dataset.mneed }); return; }
    const tb = t.closest('[data-mtab]'); if (tb) { S.tab = tb.dataset.mtab; mgo('person', { keep: true }); }
  });
  mac.addEventListener('keydown', (e) => {
    if (e.target.id !== 'mOpenDraft') return;
    if (e.key === 'Enter') commitDraft(e.target.value);
    if (e.key === 'Escape') { S.draft = null; mgo('nearby', { keep: true }); }
  });
  mac.addEventListener('focusout', (e) => { if (e.target.id === 'mOpenDraft' && S.draft != null) commitDraft(e.target.value); });
}
function commitDraft(raw) {
  const v = raw.trim(); S.draft = null;
  if (v && !S.nb.openTo.some((x) => x.toLowerCase() === v.toLowerCase()) && S.nb.openTo.length < 5) S.nb.openTo.push(v);
  mgo('nearby', { keep: true });
}
