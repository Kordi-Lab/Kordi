// iPhone: Home with the Nearby row, the Nearby screen in every state, the nearby person and the lock screen.
import { $, $$, esc, ic, bird, spinner, S, cardById } from './core.js';
import { ME, CARDS, ROOMS, RECENT, OPEN_TO, band, rangePill, scorePill, perDay, needSub, listPeople, matchingCount, personById, CHECKS, MATCH, NEEDS } from './data.js';
import { openLayer, renderLayerIOS } from './ios-layers.js';
import { syncURL } from './app.js';

// ---------- pieces ----------
export const avatar = (p, size, cls = '') => `<span class="av ${cls}" style="--s:${size}px">${esc(p.initials)}</span>`;
export const tile = (name, color) => `<span class="tile"${color ? ` style="background:${color}"` : ''}>${ic(name)}</span>`;
// Pair group icons take a hue so the Icons switch can restyle them.
export const htile = (name, hue) => `<span class="tile icn" data-hue="${hue}">${ic(name)}</span>`;
export const toggle = (on, attrs = '') => `<button class="tg" role="switch" aria-checked="${on}" ${attrs}></button>`;
export const swatch = (kind, cls = '') => `<span class="sw ${cls}" data-kind="${kind}"></span>`;
const chev = () => `<span class="chev">${ic('chev')}</span>`;
export const section = (title, body, opts = {}) => `<div class="cgs${opts.cls ? ' ' + opts.cls : ''}">${title != null ? `<div class="cgs-head"><span class="cgs-title">${esc(title)}</span>${opts.trail || ''}</div>` : ''}<div class="cgs-group"${opts.inset ? ` style="--inset:${opts.inset}px"` : ''}>${body}</div></div>`;

// Topic tints, picked the way commonGroundStyle does (djb2 over the lowercased text).
const TONES = ['#f83e9c', '#27b9d1', '#e9a20b', 'var(--tint)', '#847ac4'];
export function toneOf(topic) {
  const t = topic.toLowerCase();
  if (t.includes('memory')) return TONES[0];
  if (t.includes('eval') || t.includes('benchmark')) return TONES[3];
  let h = 5381n;
  for (const b of new TextEncoder().encode(t)) h = (h * 33n + BigInt(b)) & 0xffffffffffffffffn;
  return TONES[Number(h % 5n)];
}
export const tag = (t) => `<span class="ctag" style="--tone:${toneOf(t)}"><i></i>${esc(t)}</span>`;

// ---------- page shell ----------
function navbar(title, opts = {}) {
  return `<div class="navbar"><button class="glassbtn" id="navBack" aria-label="Back">${ic('back')}</button>${title ? `<h1>${esc(title)}</h1>` : ''}${opts.more ? `<button class="glassbtn right" id="navMore" aria-label="More" aria-haspopup="menu">${ic('more')}</button>` : ''}</div>`;
}
function page(inner, nav, cls = '') {
  return `<div class="pg tinted ${cls}" id="page">${nav}<div class="scroll" id="scroll">${inner}</div></div><div id="layer"></div>`;
}

// ---------- Home ----------
function walletHTML() {
  const active = 'work';
  const others = CARDS.filter((c) => c.id !== active);
  const nBack = Math.min(others.length, 3);
  const card = (c, y, s, z, front) => `<div class="gcard${front ? ' is-front is-active' : ''}" data-kind="${c.kind}" style="transform:translate3d(0,${y}px,0) scale(${s});z-index:${z}">
      <div class="gc-head"><span class="gc-glyph">${ic(c.kind)}</span><span class="gc-name">${esc(c.name)}</span>${front ? `<button class="gc-flip" aria-label="Card details" tabindex="-1">${ic('more')}</button>` : ''}</div>
      <div class="gc-focus">${esc(c.focus)}</div>
      <div class="gc-topics">${c.topics.slice(0, 5).map((t) => `<span class="gc-topic">${esc(t)}</span>`).join('')}</div>${bird()}</div>`;
  const backs = others.map((c, i) => { const d = Math.min(others.length - i, nBack); return card(c, (nBack - d) * 12, 1 - d * 0.045, 20 - d, false); }).join('');
  const bottom = nBack * 12 + 213;
  return `<div class="wallet" style="height:${bottom + 14 + 56}px">${backs}${card(cardById(active), nBack * 12, 1, 30, true)}<button class="gplus" style="transform:translate3d(0,${bottom + 14}px,0)">${ic('plus')}New card</button></div>`;
}
export function nearbyValue() {
  const nb = S.nb;
  if (!nb.on) return 'Off';
  if (nb.paused) return 'Paused';
  const n = listPeople(nb, S.needs).length;
  return n === 1 ? '1 person' : `${n} people`;
}
function pageHome() {
  const digits = `<span class="digits" aria-label="Pair code">${'<span></span>'.repeat(4)}</span>`;
  const pair = `<button class="row">${htile('tap', 'violet')}<span class="grow"><span class="t">Tap</span></span>${chev()}</button>
    <div class="row pc">${htile('hash', 'cyan')}<span class="grow"><span class="t">Pair code</span></span>${digits}</div>
    <button class="row link">Create a code</button>
    <button class="row" id="nearbyRow">${htile('pin', 'amber')}<span class="grow"><span class="t">Nearby</span></span><span class="val">${esc(nearbyValue())}</span>${chev()}</button>`;
  const rooms = ROOMS.map((r) => `<button class="row"><span class="grow"><span class="t">${esc(r.name)}</span><span class="s">${esc(r.sub)}</span></span>${chev()}</button>`).join('');
  const recent = RECENT.map((p) => `<button class="row prow">${avatar(p, 40)}<span class="grow"><span class="t b">${esc(p.name)}</span><span class="s">${esc(p.line)}</span></span><span class="val num">${p.score}%</span>${chev()}</button>`).join('');
  const c = cardById('work');
  const yours = `<button class="yours"><span class="yrow">${swatch(c.kind, 'lg')}<span class="grow t">${esc(c.name)}</span>${chev()}</span><span class="tags">${c.topics.map(tag).join('')}</span></button>`;
  const inner = `<div class="sharechip"><span class="sw8" data-kind="work"></span><span>Sharing: <b>Work</b></span></div>
    ${walletHTML()}
    <div class="stack24">${section(null, pair, { inset: 58 })}${section('Rooms', rooms, { inset: 16 })}${section('Recent', recent, { inset: 68 })}${section('Your card', yours)}</div>`;
  return page(inner, `<div class="navbar"><button class="glassbtn" aria-label="Back">${ic('back')}</button><h1>Grounding</h1></div>`);
}

// ---------- Nearby off ----------
function pageOff() {
  const inner = `<div class="nb-off"><span class="nb-mark">${ic('pin')}</span><h2>Nearby</h2><p>See people near you who share a card.</p><button class="primary" id="turnOn">Turn on</button></div>`;
  return page(inner, navbar(''));
}

// ---------- Nearby on, and its states ----------
export function statusHTML() {
  const nb = S.nb;
  const link = (id, text) => ` <button class="nb-link" id="${id}">${text}</button>`;
  if (nb.paused) return `<div class="nb-status">Paused until ${esc(nb.paused)}${link('resume', 'Resume')}</div>`;
  if (nb.access === 'denied') return '';
  if (!nb.fresh) return `<div class="nb-status">Location is out of date${link('update', 'Update')}</div>`;
  if (nb.access === 'limited') return `<div class="nb-status">Only while Kordi is open${link('settings', 'Settings')}</div>`;
  return '<div class="nb-status">Updated 2 min ago · Works in the background</div>';
}
function openToHTML() {
  const nb = S.nb;
  const all = OPEN_TO.concat(nb.openTo.filter((x) => !OPEN_TO.includes(x)));
  const chips = all.map((t) => { const on = nb.openTo.includes(t); return `<button class="chip${on ? ' on' : ''}" data-open="${esc(t)}" aria-pressed="${on}">${on ? ic('check') : ''}${esc(t)}</button>`; }).join('');
  const add = S.draft != null ? `<span class="chip draft"><input id="openDraft" maxlength="30" placeholder="Open to" value="${esc(S.draft)}" aria-label="Open to"></span>` : `<button class="chip add" id="openAdd" aria-label="Add" ${nb.openTo.length >= 5 ? 'disabled' : ''}>${ic('plus')}</button>`;
  return section('Open to', `<div class="chips">${chips}${add}</div>`);
}
export function personRow(p) {
  const tags = p.met.map((n) => `<span class="mtag">${ic('check')}${esc(n.label)}</span>`).join('');
  return `<button class="row prow" data-person="${p.id}">${avatar(p, 40)}<span class="grow"><span class="t b">${esc(p.name)}</span><span class="s num">${p.score}% · ${esc(band(p.m))}</span><span class="s">${esc(p.headline)}</span>${tags ? `<span class="mtags">${tags}</span>` : ''}</span>${chev()}</button>`;
}
function peopleHTML() {
  const nb = S.nb;
  if (nb.paused) return '';
  const pills = `<span class="pills"><button class="pill" id="rangePill" aria-haspopup="menu">${esc(rangePill(nb.range))}${ic('down')}</button><button class="pill" id="scorePill" aria-haspopup="menu">${esc(scorePill(nb.min))}${ic('down')}</button></span>`;
  if (nb.access === 'denied') {
    return section('People', `<div class="row"><span class="grow"><span class="t">Location access is off</span></span><button class="small-btn" id="settings">Settings</button></div>`);
  }
  if (!nb.fresh) {
    const dim = listPeople(nb, S.needs).map((p) => `<div class="row prow dim">${avatar(p, 40)}<span class="grow"><span class="t b">${esc(p.name)}</span></span></div>`).join('');
    return section('People', `<div class="row"><span class="grow"><span class="s">Update to see who is nearby</span></span></div>${dim}`, { inset: 16 });
  }
  const people = listPeople(nb, S.needs);
  const more = matchingCount(nb);
  const rows = people.map(personRow).join('') + (more ? `<div class="row prow matching"><span class="spinbox">${spinner()}</span><span class="grow"><span class="s">Matching ${more} more</span></span></div>` : '');
  return section('People', rows || '<div class="row"><span class="grow"><span class="s">No one nearby yet</span></span></div>', { trail: pills, inset: rows ? 68 : 16 });
}
function needsHTML() {
  const rows = S.needs.map((n) => `<button class="row${n.ended ? ' ended' : ''}" data-need="${n.id}"><span class="grow"><span class="t">${esc(n.text)}</span><span class="s">${esc(needSub(n))}</span></span>${chev()}</button>`).join('');
  return section('Looking for', `${rows}<button class="row addrow" id="needAdd" ${S.needs.length >= 10 ? 'disabled' : ''}>${ic('plus')}Add</button>`, { inset: 16 });
}
function alertsHTML() {
  const a = S.nb.alerts;
  return section('Alerts', `<div class="row"><span class="grow"><span class="t">Requests</span></span>${toggle(a.requests, 'data-alert="requests" aria-label="Requests"')}</div>
    <div class="row"><span class="grow"><span class="t">Good matches</span><span class="s">85% and up</span></span>${toggle(a.matches, 'data-alert="matches" aria-label="Good matches"')}</div>
    <button class="row" id="perDay" aria-haspopup="menu"><span class="grow"><span class="t">At most</span></span><span class="val">${esc(perDay(a.max))}</span><span class="ud">${ic('updown')}</span></button>`, { inset: 16 });
}
function pageNearby() {
  const c = cardById(S.nb.card);
  const inner = `<div class="nb-top"><button class="cardchip" id="cardChip" aria-haspopup="menu">${swatch(c.kind, 'xs')}<span>Sharing ${esc(c.name)}</span>${ic('down')}</button>${statusHTML()}</div>
    <div class="stack24">${openToHTML()}${peopleHTML()}${needsHTML()}${alertsHTML()}</div>`;
  return page(inner, navbar('Nearby', { more: true }));
}

// ---------- the nearby person ----------
export function requestsHTML(pid, mac) {
  const blocks = (CHECKS[pid] || []).map((b) => {
    const n = S.needs.find((x) => x.id === b.need) || NEEDS.find((x) => x.id === b.need);
    if (!n || n.ended || n.paused) return '';
    const checks = b.checks.map((k) => `<div class="chk${k.met ? ' met' : ''}"><span class="chk-i">${k.met ? ic('check') : ''}</span><span class="chk-x"><span class="chk-t">${esc(k.text)}</span><span class="chk-e">${esc(k.evidence)}</span></span></div>`).join('');
    return `<div class="req"><div class="req-t">${esc(n.text)}</div>${checks}</div>`;
  }).join('');
  if (!blocks) return '';
  return mac ? blocks : section('Your requests', blocks);
}
function matchRows(items) {
  return items.map((r) => `<div class="row">${tile(r.icon, `var(--t-${r.tone})`)}<span class="grow"><span class="t">${esc(r.topic)}</span><span class="s wrap">${esc(r.why)}</span></span></div>`).join('');
}
function pagePerson() {
  const p = personById(S.person);
  const added = S.added[p.id];
  const tiles = `<div class="acts"><button class="act" id="actAdd" ${added ? 'disabled' : ''}>${ic(added ? 'clock' : 'userPlus')}<span>${added ? 'Requested' : 'Add'}</span></button><button class="act" disabled>${ic('message')}<span>Message</span></button><button class="act" disabled>${ic('calendar')}<span>Meet</span></button></div>`;
  const tab = S.tab;
  const body = tab === 'shared'
    ? section(null, matchRows(MATCH.shared), { inset: 58 })
    : `${section('You bring', matchRows(MATCH.youBring), { inset: 58 })}${section(`${p.name.split(' ')[0]} brings`, matchRows(MATCH.theyBring), { inset: 58 })}`;
  const inner = `<div class="hero"><span class="badge">${avatar(ME, 80, 'ring')}${avatar(p, 80, 'ring')}<em>${p.score}% match</em></span>
      <h2>${esc(p.name)}</h2><div class="hero-line"><span class="pchip">${swatch(p.profile.kind, 'xs')}${esc(p.profile.name)}</span><span>${esc(band(p.m))}</span></div>${tiles}</div>
    <div class="stack16">${requestsHTML(p.id)}
      <div class="seg" role="tablist" aria-label="Match"><button role="tab" data-tab="shared" aria-selected="${tab === 'shared'}">Shared</button><button role="tab" data-tab="trade" aria-selected="${tab === 'trade'}">Trade</button></div>
      ${body}</div>`;
  return page(inner, navbar(''), 'person');
}

// ---------- lock screen ----------
function pageLock() {
  const match = S.alert === 'match';
  const body = match ? '92% match · Under 1 km' : 'Someone founding a startup · Under 500 m';
  return `<div class="lock" id="page"><div class="lock-date">Monday, October 26</div><div class="lock-time">${esc(S.clock)}</div>
    <button class="notif" id="notif"><span class="appicon">${bird('appbird')}</span><span class="nbody"><span class="ntop"><b>Maya Chen is nearby</b><em>now</em></span><span class="ntext">${esc(body)}</span></span></button>
    <div class="lock-foot"><span class="lockbtn">${ic('flash')}</span><span class="lockbtn">${ic('camera')}</span></div></div><div id="layer"></div>`;
}

// ---------- render and wire ----------
const PAGES = { home: pageHome, off: pageOff, nearby: pageNearby, person: pagePerson, lock: pageLock };
export function renderIOS() {
  const old = $('#scroll'); const top = old ? old.scrollTop : 0;
  const keep = S.keepScroll === S.page;
  $('#screen').innerHTML = PAGES[S.page]();
  $('#phone').classList.toggle('locked', S.page === 'lock');
  $('#clock').textContent = S.clock;
  if (keep && $('#scroll')) $('#scroll').scrollTop = top;
  S.keepScroll = S.page;
  bindPage();
  if (S.layer) renderLayerIOS(true);
  if (S.draft != null) { const d = $('#openDraft'); if (d) { d.focus(); d.setSelectionRange(d.value.length, d.value.length); } }
}
export function go(pageName, opts = {}) {
  S.page = pageName; S.layer = null;
  if (!opts.keep) { S.keepScroll = null; S.draft = null; }
  renderIOS(); syncURL();
}
function bindPage() {
  const scr = $('#screen');
  $('#navBack')?.addEventListener('click', () => go(S.page === 'person' ? 'nearby' : 'home'));
  $('#nearbyRow')?.addEventListener('click', () => go(S.nb.on ? 'nearby' : 'off'));
  $('#turnOn')?.addEventListener('click', () => openLayer({ type: 'consent' }));
  $('#navMore')?.addEventListener('click', (e) => openLayer({ type: 'menu', menu: 'more', anchor: '#navMore' }, e));
  $('#cardChip')?.addEventListener('click', () => openLayer({ type: 'menu', menu: 'card', anchor: '#cardChip' }));
  $('#rangePill')?.addEventListener('click', () => openLayer({ type: 'menu', menu: 'range', anchor: '#rangePill' }));
  $('#scorePill')?.addEventListener('click', () => openLayer({ type: 'menu', menu: 'score', anchor: '#scorePill' }));
  $('#perDay')?.addEventListener('click', () => openLayer({ type: 'menu', menu: 'perday', anchor: '#perDay' }));
  $('#needAdd')?.addEventListener('click', () => openLayer({ type: 'request', id: null }));
  $('#resume')?.addEventListener('click', () => { S.nb.paused = null; S.clock = '3:41'; go('nearby', { keep: true }); });
  $('#update')?.addEventListener('click', () => { S.nb.fresh = true; go('nearby', { keep: true }); });
  $$('#settings', scr).forEach((b) => b.addEventListener('click', () => { S.nb.access = 'always'; go('nearby', { keep: true }); }));
  $('#notif')?.addEventListener('click', () => { S.person = 'maya'; go('person'); });
  $('#actAdd')?.addEventListener('click', () => { S.added[S.person] = true; go('person', { keep: true }); });
  $('#openAdd')?.addEventListener('click', () => { S.draft = ''; go('nearby', { keep: true }); });
  const draft = $('#openDraft');
  if (draft) {
    const commit = () => { const v = draft.value.trim(); S.draft = null; if (v && !S.nb.openTo.some((x) => x.toLowerCase() === v.toLowerCase()) && S.nb.openTo.length < 5) S.nb.openTo.push(v); go('nearby', { keep: true }); };
    draft.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { S.draft = null; go('nearby', { keep: true }); } });
    draft.addEventListener('blur', () => { if (S.draft != null) commit(); });
  }
  if (scr.dataset.bound) return;
  scr.dataset.bound = '1';
  scr.addEventListener('click', (e) => {
    if (S.mode !== 'ios') return;
    const t = e.target;
    const chip = t.closest('[data-open]');
    if (chip) {
      const v = chip.dataset.open; const list = S.nb.openTo;
      S.nb.openTo = list.includes(v) ? list.filter((x) => x !== v) : list.length < 5 ? list.concat(v) : list;
      go('nearby', { keep: true }); return;
    }
    const sw = t.closest('[data-alert]');
    if (sw) { const k = sw.dataset.alert; S.nb.alerts[k] = !S.nb.alerts[k]; sw.setAttribute('aria-checked', String(S.nb.alerts[k])); return; }
    const pr = t.closest('[data-person]'); if (pr) { S.person = pr.dataset.person; S.tab = 'shared'; go('person'); return; }
    const nd = t.closest('[data-need]'); if (nd) { openLayer({ type: 'request', id: nd.dataset.need }); return; }
    const tb = t.closest('[data-tab]'); if (tb) { S.tab = tb.dataset.tab; go('person', { keep: true }); }
  });
}
