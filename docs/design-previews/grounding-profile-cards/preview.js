'use strict';
// Grounding profile cards: an interactive proposal. Synthetic people and data, no network calls.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const DUR = () => (reduced.matches ? 0 : 300);
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
let timers = [];

// ---------- icons ----------
const I = {
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
const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[name] || I.sparkle}</svg>`;
const bird = () => '<svg class="gc-mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#kbird" width="24" height="24"/></svg>';

// ---------- synthetic data ----------
const KINDS = {
  work: { label: 'Work', fixed: true },
  health: { label: 'Health', fixed: true },
  daily: { label: 'Daily tasks', fixed: true },
  workshop: { label: 'Workshop' },
  research: { label: 'Research group', placeholder: 'Group name' },
  custom: { label: 'Custom', placeholder: 'Name' },
};
const DESIGNS = ['work', 'health', 'daily', 'workshop', 'research', 'custom'];
const MAX_CARDS = 5;
const BUILT = {
  work: ['Agent memory', 'Long-context evaluation', 'Tool-use safety', 'Retrieval', 'Tracing'],
  health: ['Half marathon training', 'Sleep tracking', 'Plant-based cooking'],
  daily: ['Bike repair', 'Grocery planning', 'Moving apartments', 'Language exchange'],
  workshop: ['Memory benchmarks', 'Poster feedback', 'Reading group'],
  research: ['Video understanding', 'Dataset curation', 'Shared GPU cluster', 'Arabic speech'],
  custom: ['Board games', 'Weekend hikes', 'Film club'],
};
const SOURCES = { Memory: 'memory', Gmail: 'mail', Calendar: 'calendar', Papers: 'paper', Health: 'heart', Notes: 'note' };
const SEED = () => [
  { id: 'work', kind: 'work', name: 'Work', focus: 'Memory for long-horizon agents', topics: BUILT.work.slice(), hidden: [], sources: ['Memory', 'Papers', 'Calendar'] },
  { id: 'kaust', kind: 'research', name: 'KAUST', focus: 'Visiting the vision group this spring', topics: BUILT.research.slice(), hidden: [], sources: ['Memory', 'Gmail'] },
  { id: 'poster', kind: 'workshop', name: 'Workshops', focus: 'Poster on memory benchmarks', topics: BUILT.workshop.slice(), hidden: [], sources: ['Calendar', 'Papers'] },
  { id: 'health', kind: 'health', name: 'Health', focus: 'Running and better sleep', topics: BUILT.health.slice(), hidden: [], sources: ['Health', 'Notes'] },
];
const ROOMS = () => [
  { id: 'poster26', code: '4821', name: 'Poster session 2026', kind: 'workshop', people: 14, open: true, sharing: null, listed: false },
  { id: 'lunch', code: '3907', name: 'Lab lunch', kind: 'work', people: 5, open: false, sharing: 'work' },
  { id: 'run', code: '5160', name: 'Running club', kind: 'health', people: 8, open: true, sharing: 'health' },
];
const ME = { name: 'Maya Chen', initials: 'MC' };
const PEOPLE = [
  { name: 'Tomas Ruiz', initials: 'TR', line: 'Privacy engineering group' },
  { name: 'Priya Nair', initials: 'PN', line: 'HCI lab' },
];
const NEW_CODE = '7319';

// ---------- state ----------
let S = null;
function freshState(mode) {
  return { mode, cards: SEED(), active: 'work', fanned: false, suggest: false, building: null, rooms: ROOMS(), sheet: null, confirm: null, lastJump: null, renaming: false };
}
const cardById = (id) => S.cards.find((c) => c.id === id);
const activeCard = () => cardById(S.active) || S.cards[0] || null;
const takenKinds = () => S.cards.map((c) => c.kind).filter((k) => KINDS[k].fixed);
function walletList() {
  if (S.suggest && !S.cards.length) return [{ id: 'suggest', kind: 'work', name: 'Work', focus: '', topics: [], hidden: [], sources: [], suggested: true }];
  return S.cards;
}
const ios = () => S.mode === 'ios';
const geo = () => (ios() ? { cw: 338, ch: 213, peek: 12, strip: 54, plusH: 56 } : { cw: 372, ch: 235, peek: 12, strip: 56, plusH: 56 });

// ---------- card markup ----------
function visibleTopics(c) { return (c.topics || []).filter((t) => !(c.hidden || []).includes(t)).slice(0, 5); }
function topicsHTML(c, opts = {}) {
  if (S.building === c.id) return '<span class="gc-build busy"><i class="spin"></i>Building</span>';
  const ts = visibleTopics(c);
  if (ts.length) return ts.map((t, i) => `<span class="gc-topic${opts.pop ? ' pop' : ''}" style="${opts.pop ? `animation-delay:${i * 60}ms` : ''}">${esc(t)}</span>`).join('');
  if (opts.skeleton) return ['70px', '96px', '58px'].map((w) => `<span class="gc-topic skel" style="--w:${w}">.</span>`).join('');
  return `<button class="gc-build" data-build="${esc(c.id)}">Build</button>`;
}
function cardInner(c, opts = {}) {
  return `<div class="gc-head"><span class="gc-glyph">${ic(c.kind)}</span><span class="gc-name">${esc(c.name)}</span>${opts.flip ? `<button class="gc-flip" aria-label="Card details" tabindex="-1">${ic('flip')}</button>` : ''}<span class="gc-check" aria-hidden="true">${ic('check')}</span></div>
    <div class="gc-focus">${esc(c.suggested ? 'Suggested' : c.focus || '')}</div>
    <div class="gc-topics">${topicsHTML(c, opts)}</div>${bird()}`;
}
const cardHTML = (c, opts = {}) => `<div class="gcard${opts.cls ? ' ' + opts.cls : ''}" data-kind="${c.kind}" data-id="${esc(c.id)}">${cardInner(c, opts)}</div>`;

// ---------- shell ----------
const avatar = (p, size) => `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(p.initials)}</span>`;
function chipHTML() {
  const c = S.suggest && !S.cards.length ? null : activeCard();
  if (!c) return '<div class="sharechip is-empty" id="chip"></div>';
  return `<div class="sharechip" id="chip"><span class="sw8" data-kind="${c.kind}"></span><span>Sharing: <b>${esc(c.name)}</b></span></div>`;
}
function renderIOS() {
  $('#screen').innerHTML = `<div class="pg" id="page">
      <div class="navbar"><button class="glassbtn" aria-label="Back">${ic('back')}</button><h1>Grounding</h1></div>
      <div class="scroll" id="scroll">
        <div id="chipwrap">${chipHTML()}</div>
        <div class="wallet" id="wallet"></div>
        <div id="below"></div>
      </div>
    </div><div id="layer"></div>`;
  mountWallet();
  renderBelow();
}
function renderChip(swap) {
  const wrap = $('#chipwrap'); if (!wrap) return;
  if (!ios() && swap && !reduced.matches) {
    // Mac: the old chip fades out over the new one (200 ms crossfade).
    $$('.sharechip.out', wrap).forEach((el) => el.remove());
    const old = $('#chip', wrap);
    if (old) { old.id = ''; old.classList.add('out'); later(() => old.remove(), 220); }
    wrap.insertAdjacentHTML('beforeend', chipHTML());
    $('#chip', wrap).classList.add('fadein');
    return;
  }
  wrap.innerHTML = chipHTML();
  if (swap && !reduced.matches) $('#chip').classList.add('swap');
}

// ---------- wallet ----------
function mountWallet() {
  const w = $('#wallet');
  w.innerHTML = `<button class="gplus" id="gplus">${ic('plus')}New card</button>`;
  syncWalletCards(true);
  w.addEventListener('click', onWalletClick);
  w.addEventListener('keydown', (e) => {
    const card = e.target.closest('.gcard');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onWalletCard(card, e); }
  });
}
function syncWalletCards(instant) {
  const w = $('#wallet'); if (!w) return;
  const list = walletList();
  const have = new Map($$('.gcard', w).map((el) => [el.dataset.id, el]));
  for (const [id, el] of have) if (!list.some((c) => c.id === id)) el.remove();
  const plus = $('#gplus');
  list.forEach((c) => {
    let el = have.get(c.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'gcard';
      el.dataset.id = c.id;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      if (!instant && plus) { el.style.transform = plus.style.transform + ' scale(.9)'; el.style.opacity = '0'; }
      w.insertBefore(el, plus);
      void el.offsetWidth;
    }
    el.dataset.kind = c.kind;
    el.setAttribute('aria-label', `${c.name} card`);
    el.innerHTML = cardInner(c, { flip: !c.suggested });
  });
  if (instant) w.classList.add('instant');
  layoutWallet();
  if (instant) { void w.offsetWidth; w.classList.remove('instant'); }
}
function place(el, y, s, z, o) {
  if (!el) return;
  el.style.transform = `translate3d(0, ${y}px, 0) scale(${s})`;
  el.style.zIndex = z; el.style.opacity = o;
}
function layoutWallet() {
  const w = $('#wallet'); if (!w) return;
  const g = geo(); const list = walletList();
  const els = new Map($$('.gcard', w).map((el) => [el.dataset.id, el]));
  const activeId = list.some((c) => c.id === S.active) ? S.active : list[0]?.id;
  const fanned = S.fanned && list.length > 1;
  w.classList.toggle('fanned', fanned);
  let bottom = -14;
  if (fanned) {
    list.forEach((c, i) => place(els.get(c.id), i * g.strip, 1, i + 1, 1));
    bottom = (list.length - 1) * g.strip + g.ch;
  } else if (list.length) {
    const others = list.filter((c) => c.id !== activeId);
    const nBack = Math.min(others.length, 3);
    others.forEach((c, i) => {
      const d = others.length - i; const dd = Math.min(d, nBack);
      place(els.get(c.id), (nBack - dd) * g.peek, 1 - dd * 0.045, 20 - d, d > 3 ? 0 : 1);
    });
    place(els.get(activeId), nBack * g.peek, 1, 30, 1);
    bottom = nBack * g.peek + g.ch;
  }
  els.forEach((el, id) => { el.classList.toggle('is-active', id === activeId); el.classList.toggle('is-front', !fanned && id === activeId); });
  const plus = $('#gplus');
  const showPlus = S.cards.length < MAX_CARDS;
  plus.hidden = !showPlus;
  plus.style.transform = `translate3d(0, ${bottom + 14}px, 0)`;
  w.style.height = (showPlus ? bottom + 14 + g.plusH : Math.max(bottom, 0)) + 'px';
}
function onWalletClick(e) {
  const b = e.target.closest('[data-build]');
  if (b) { e.stopPropagation(); startBuild(b.dataset.build); return; }
  if (e.target.closest('#gplus')) { openNew(); return; }
  const card = e.target.closest('.gcard');
  if (card) onWalletCard(card, e);
}
function onWalletCard(card, e) {
  const id = card.dataset.id;
  if (id === 'suggest') return;
  if (e.target.closest('.gc-flip')) { openDetail(id); return; }
  const list = walletList();
  if (!S.fanned) {
    if (list.length < 2) { openDetail(id); return; }
    S.fanned = true;
  } else {
    if (id !== S.active) { S.active = id; renderChip(true); renderBelow(); }
    S.fanned = false;
  }
  S.lastJump = null;
  layoutWallet(); syncURL();
}
function startBuild(id) {
  if (!ios()) { macBuild(id); return; }
  if (id === 'suggest') {
    S.cards = [{ id: 'work', kind: 'work', name: 'Work', focus: '', topics: [], hidden: [], sources: ['Memory', 'Papers', 'Calendar'] }];
    S.suggest = false; S.active = 'work';
    const el = $('#wallet .gcard[data-id="suggest"]'); if (el) el.dataset.id = 'work';
  }
  S.building = id; S.lastJump = null;
  syncWalletCards();
  $(`#wallet .gcard[data-id="${id}"]`)?.classList.add('building');
  renderChip(true); renderBelow(); syncURL();
  later(() => {
    const c = cardById(id); if (!c) return;
    c.topics = BUILT[c.kind].slice();
    if (c.kind === 'work' && !c.focus) c.focus = 'Memory for long-horizon agents';
    S.building = null;
    const el = $(`#wallet .gcard[data-id="${id}"]`);
    if (el) { el.classList.remove('building'); el.innerHTML = cardInner(c, { flip: true, pop: true }); }
    renderBelow();
  }, reduced.matches ? 300 : 1500);
}

// ---------- below the wallet ----------
function roomSub(r) {
  const shared = r.sharing ? cardById(r.sharing) : null;
  if (r.mine) return [`Sharing ${shared ? shared.name : KINDS[r.kind].label}`, 'you', r.people === 1 ? '1 person' : `${r.people} people`].join(' · ');
  return [shared ? `Sharing ${shared.name}` : KINDS[r.kind].label, `${r.people} people`, r.open ? '' : 'Closed'].filter(Boolean).join(' · ');
}
function renderBelow() {
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
function roomLead(r) { const shared = r.sharing ? cardById(r.sharing) : null; return shared ? `<span class="mini" data-kind="${shared.kind}"></span>` : `<span class="mini none" data-kind="${r.kind}"></span>`; }
function roomRowIOS(r) {
  const trail = r.sharing ? `<span class="chev">${ic('chev')}</span>` : '<span class="small-btn">Join</span>';
  return `<button class="row" data-room="${r.id}" ${r.open ? '' : 'disabled'}>${roomLead(r)}<span class="grow"><div class="title">${esc(r.name)}</div><div class="sub">${esc(roomSub(r))}</div></span>${trail}</button>`;
}
function openRoom(id, anchor) {
  const r = S.rooms.find((x) => x.id === id); if (!r || !r.open) return;
  const suggested = S.cards.find((c) => c.kind === r.kind && c.topics.length);
  openChoose('room', r.sharing || suggested?.id || S.active, { room: r.id, suggested: suggested?.id || null, anchor });
}

// ---------- layers ----------
function layer() { return $('#layer'); }
function overlayHost() { return ios() ? $('#screen') : $('#mac'); }
function closeLayer(after) {
  const l = layer(); if (!l) return;
  $$('.dimmer, .sheet, .m-dim, .m-pop', l).forEach((el) => el.classList.remove('on'));
  later(() => { l.innerHTML = ''; S.sheet = null; if (after) after(); syncURL(); }, DUR());
}
function showLayer(html, bind) {
  const l = layer();
  l.innerHTML = html;
  if (bind) bind(l);
  void l.offsetWidth;
  requestAnimationFrame(() => $$('.dimmer, .sheet, .m-dim, .m-pop', l).forEach((el) => el.classList.add('on')));
}
function instantOn() { $$('.dimmer, .sheet, .m-dim, .m-pop', layer()).forEach((el) => { el.style.transition = 'none'; el.classList.add('on'); void el.offsetWidth; el.style.transition = ''; }); }
function toast(text) {
  const host = overlayHost(); if (!host) return;
  $$('.toast, .m-toast', host).forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = ios() ? 'toast' : 'm-toast';
  t.textContent = text;
  host.appendChild(t);
  later(() => { t.style.opacity = '0'; later(() => t.remove(), 250); }, 2200);
}

// ---------- carousel ----------
function bindCarousel(car, onSel) {
  const items = $$('.car-item', car);
  let cur = items.findIndex((it) => it.classList.contains('is-sel'));
  const center = (i, smooth) => {
    const it = items[i]; if (!it) return;
    const left = it.offsetLeft - (car.clientWidth - it.offsetWidth) / 2;
    car.scrollTo({ left, behavior: smooth && !reduced.matches ? 'smooth' : 'auto' });
  };
  const select = (i) => {
    if (i === cur || i < 0 || i >= items.length) return;
    cur = i;
    items.forEach((it, j) => it.classList.toggle('is-sel', j === i));
    onSel(i);
  };
  let raf = 0;
  car.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const mid = car.scrollLeft + car.clientWidth / 2;
      let best = 0, bd = Infinity;
      items.forEach((it, j) => { const d = Math.abs(it.offsetLeft + it.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = j; } });
      select(best);
    });
  });
  items.forEach((it, j) => it.addEventListener('click', () => { if (j !== cur) { select(j); center(j, true); } }));
  requestAnimationFrame(() => center(cur, false));
  center(cur, false);
  return { go: (i) => { select(i); center(i, true); }, cur: () => cur };
}
const dotsHTML = (n, on) => `<div class="dots">${Array.from({ length: n }, (_, i) => `<i class="${i === on ? 'on' : ''}"></i>`).join('')}</div>`;
function setDots(box, on) { $$('.dots i', box).forEach((d, i) => d.classList.toggle('on', i === on)); }
const suggHTML = () => `<div class="sugg"><span>${ic('sparkle')}Suggested for this room</span></div>`;

// ---------- choose a card ----------
function chooseList() { return S.cards.filter((c) => c.topics.length); }
function openChoose(purpose, sel, opts = {}) {
  const list = chooseList(); if (!list.length) return;
  if (!list.some((c) => c.id === sel)) sel = list[0].id;
  S.sheet = { type: 'choose', purpose, sel, step: 'pick', room: opts.room || null, suggested: opts.suggested || null };
  S.fanned = false; layoutWallet();
  chooseIOS();
  if (opts.instant) instantOn();
  syncURL();
}
function chooseTitle() { return S.rooms.find((r) => r.id === S.sheet.room).name; }
function chooseSub() {
  const sh = S.sheet; if (sh.purpose !== 'room') return '';
  const r = S.rooms.find((x) => x.id === sh.room);
  return `<span class="stackav">${PEOPLE.map((p) => avatar(p, 22)).join('')}</span><span>Tomas, Priya and ${r.people - 2} others</span>`;
}
const primaryLabel = () => 'Share this card';
function chooseIOS() {
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
function bindChoose(l) {
  const dismiss = () => { S.code = ''; closeLayer(() => renderBelow()); };
  $('#chX', l).addEventListener('click', dismiss);
  $('#dim', l)?.addEventListener('click', dismiss);
  const car = $('#car', l);
  const list = chooseList();
  if (car) bindCarousel(car, (i) => { S.sheet.sel = list[i].id; setDots(l, i); });
  $('#chGo', l)?.addEventListener('click', confirmChoose);
  $('#chDone', l)?.addEventListener('click', () => closeLayer());
}
function confirmChoose() {
  const sh = S.sheet;
  const r = S.rooms.find((x) => x.id === sh.room); const c = cardById(sh.sel);
  const was = r.sharing;
  joinRoom(r, c);
  closeLayer(() => { renderBelow(); toast(was && was !== c.id ? `Now sharing ${c.name}` : `Sharing ${c.name} in ${r.name}`); });
}
// ---------- pair code: join a room by its four digits, or create a meetup ----------
function listedRooms() { return S.rooms.filter((r) => r.listed !== false); }
function joinRoom(r, c) {
  r.sharing = c.id; r.listed = true;
  S.rooms = [r].concat(S.rooms.filter((x) => x !== r));
  S.code = ''; S.pending = null; S.codeErr = '';
}
function digitsHTML(disabled) {
  const v = (S.code || '').split('');
  return `<span class="digits" role="group" aria-label="Pair code">${[0, 1, 2, 3].map((i) => `<input class="dig" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="Digit ${i + 1}" value="${esc(v[i] || '')}" ${disabled ? 'disabled' : ''}>`).join('')}</span>`;
}
function bindDigits(box) {
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
function submitCode(code) {
  const r = S.rooms.find((x) => x.code === code);
  S.lastJump = null;
  if (!r || !r.open) { S.code = ''; S.pending = null; S.codeErr = 'Room not found'; renderBelow(); syncURL(); return; }
  if (r.sharing) { S.code = ''; S.pending = null; S.codeErr = ''; renderBelow(); toast(`Already in ${r.name}`); syncURL(); return; }
  S.codeErr = '';
  if (ios()) { openRoom(r.id); return; }
  S.pending = r.id; macRefresh(); syncURL();
}
function openCreate(cardId, opts = {}) {
  const list = chooseList(); if (!list.length) return;
  if (!list.some((c) => c.id === cardId)) cardId = list[0].id;
  S.fanned = false; layoutWallet();
  S.sheet = { type: 'create', step: 'form', name: opts.name || '', card: cardId, code: NEW_CODE, anchor: opts.anchor || null };
  if (ios()) createIOS(); else createMac();
  if (opts.instant) instantOn();
  syncURL();
}
function createFormHTML() {
  const sh = S.sheet; const c = cardById(sh.card);
  return `<div class="cf-label">Share</div>
    <div class="cf-cards" role="radiogroup" aria-label="Card">${chooseList().map((x) => `<button class="cf-sw${x.id === sh.card ? ' on' : ''}" data-kind="${x.kind}" data-card="${esc(x.id)}" role="radio" aria-checked="${x.id === sh.card}" aria-label="${esc(x.name)}" title="${esc(x.name)}">${ic(x.kind)}</button>`).join('')}<span class="cf-pick">${esc(c.name)}</span></div>`;
}
function createDoneHTML() {
  const sh = S.sheet; const c = cardById(sh.card);
  return `<div class="cd-code" aria-label="Code ${sh.code.split('').join(' ')}">${sh.code.split('').map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cd-name">${esc(sh.name)}</div><div class="cd-sub"><span class="mini" data-kind="${c.kind}"></span>Sharing ${esc(c.name)}</div>`;
}
function createSubmit() {
  const sh = S.sheet; if (!sh || !sh.name.trim()) return;
  const c = cardById(sh.card);
  const room = { id: 'm' + sh.code, code: sh.code, name: sh.name.trim(), kind: c.kind, people: 1, open: true, sharing: c.id, mine: true, listed: true };
  S.rooms = [room].concat(S.rooms.filter((x) => x.code !== sh.code));
  sh.name = room.name; sh.step = 'done';
  renderBelow();
  if (ios()) paintCreateIOS(true); else paintCreateMac(true);
  syncURL();
}
function bindCreate(l) {
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
function createIOS() {
  showLayer(`<div class="dimmer" id="dim"></div><div class="sheet"><div class="grab"></div>
      <div class="shead"><h2 id="cfTitle"></h2><button class="x" id="cfX" aria-label="Close">${ic('close')}</button></div>
      <div class="sbody" id="cfBody"></div></div>`, (l) => { $('#dim', l).addEventListener('click', () => closeLayer()); bindCreate(l); });
  paintCreateIOS();
}
function paintCreateIOS(swap) {
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

// ---------- new card ----------
function newDraft(i) { const kind = DESIGNS[i]; return { id: 'draft-' + kind, kind, name: '', focus: '', topics: [], hidden: [] }; }
function editCardHTML(i, sh) {
  const kind = DESIGNS[i]; const k = KINDS[kind];
  const taken = takenKinds().includes(kind);
  const ph = k.fixed ? k.label : k.placeholder || k.label;
  return `<div class="gcard edit" data-kind="${kind}">
    <div class="gc-head"><span class="gc-glyph">${ic(kind)}</span><label class="gc-field"><input class="gc-name" data-f="name" placeholder="${esc(ph)}" value="${esc(sh.name)}" maxlength="40" aria-label="Name" ${taken ? 'disabled' : ''} autocomplete="off"></label>${taken ? '<span class="gc-badge">In your wallet</span>' : ''}</div>
    <div class="gc-focus"><label class="gc-field"><input class="gc-focus-in" data-f="focus" placeholder="Focus" value="${esc(sh.focus)}" maxlength="200" aria-label="Focus" ${taken ? 'disabled' : ''} autocomplete="off"></label></div>
    <div class="gc-topics">${topicsHTML(newDraft(i), { skeleton: true })}</div>${bird()}</div>`;
}
function canCreate() {
  const sh = S.sheet; const kind = DESIGNS[sh.idx];
  if (takenKinds().includes(kind)) return false;
  return KINDS[kind].fixed || Boolean(sh.name.trim());
}
function firstFreeDesign() { const t = takenKinds(); const i = DESIGNS.findIndex((k) => !t.includes(k)); return i < 0 ? 3 : i; }
function openNew(opts = {}) {
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
function bindNew(l) {
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
function createCard() {
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
function backHTML(c, renaming) {
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
function hostScale(host) { return host.getBoundingClientRect().width / host.offsetWidth || 1; }
function detailTarget(host) {
  const g = geo();
  const top = ios() ? 104 : 84;
  const left = ios() ? (host.offsetWidth - g.cw) / 2 : 68 + 264 + (host.offsetWidth - 68 - 264 - g.cw) / 2;
  return { top, left, maxH: host.offsetHeight - top - (ios() ? 44 : 40) };
}
function srcRect(host, id) {
  const src = $(`#wallet .gcard[data-id="${id}"]`); if (!src) return null;
  const hr = host.getBoundingClientRect(); const sr = src.getBoundingClientRect(); const k = hostScale(host);
  return { el: src, top: (sr.top - hr.top) / k, left: (sr.left - hr.left) / k };
}
function openDetail(id, opts = {}) {
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
function fitDetail() {
  const ov = $('#dov'); if (!ov) return;
  const host = overlayHost(); const t = detailTarget(host);
  const h = Math.min($('#gbin', ov).offsetHeight, t.maxH);
  $('.flip', ov).style.height = Math.max(h, geo().ch) + 'px';
}
function paintBack() {
  const c = cardById(S.sheet.id); const back = $('#gback');
  back.innerHTML = backHTML(c, S.sheet.renaming);
  fitDetail();
  if (S.sheet.renaming) { const inp = $('#gbName'); inp.focus(); inp.select(); }
}
function bindDetail(ov) {
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
function saveRename() {
  if (!S.sheet || !S.sheet.renaming) return;
  const c = cardById(S.sheet.id); const v = $('#gbName').value.trim();
  if (v) c.name = v;
  S.sheet.renaming = false;
  paintBack(); refreshCard(c); renderChip(); renderBelow();
}
function refreshCard(c) {
  const el = $(`#wallet .gcard[data-id="${c.id}"]`); if (el) el.innerHTML = cardInner(c, { flip: true });
  const front = $('#dov .gcard.face'); if (front) front.innerHTML = cardInner(c);
  if (c.id === S.active) renderBelow();
}
function closeDetail(after) {
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
function openConfirm(id) {
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
function closeConfirm() { $('#confirm')?.remove(); S.confirm = null; }

// ---------- Mac ----------
// The deck: the cards in an aligned drawer on the left, one action column beside it.
// Home is the cards plus one action column (Pair code, Rooms, Recent). "Open" on the selected card pushes its page.
const MAC_W = 1400, MAC_H = 820;
const RECENT = [
  { p: PEOPLE[0], card: 'work', common: 4 },
  { p: PEOPLE[1], card: 'poster', common: 3 },
];
// References as the app shows them: source, date, title, snippet (latest first).
const REFS = {
  'Agent memory': [['Memory', '12 Oct', 'Saved memory', 'Started the long-horizon memory draft with Priya.'], ['Papers', '3 Oct', 'Agent memory survey.pdf', 'Section 4 compares episodic and semantic stores.']],
  'Long-context evaluation': [['Calendar', '9 Oct', 'Eval reading group', 'Weekly, with the evaluation group.'], ['Papers', '28 Sep', 'Needle tests at a million tokens.pdf', 'Where recall drops past 200k tokens.']],
  'Tool-use safety': [['Memory', '6 Oct', 'Saved memory', 'Notes on sandboxing shell tools.']],
  'Retrieval': [['Calendar', '15 Oct', 'Retrieval sync with Tomas', 'Agenda: chunking and reranking.']],
  'Tracing': [['Memory', '1 Oct', 'Saved memory', 'Trace viewer for agent runs.']],
  'Video understanding': [['Gmail', '2 Oct', 'Visit plan for the vision group', 'Two weeks in March, a desk in the vision lab.']],
  'Dataset curation': [['Memory', '7 Oct', 'Saved memory', 'Desert scenes dataset cleanup.']],
  'Shared GPU cluster': [['Gmail', '30 Sep', 'Cluster account approved', 'Access to the shared GPU queue.']],
  'Arabic speech': [['Memory', '11 Oct', 'Saved memory', 'Speech demo with the lab.']],
  'Memory benchmarks': [['Papers', '13 Oct', 'Poster draft v3.pdf', 'Benchmark table and three failure cases.']],
  'Poster feedback': [['Calendar', '16 Oct', 'Poster review with Priya', 'Thirty minutes before the session.']],
  'Reading group': [['Calendar', '8 Oct', 'Workshop reading group', 'This week: memory for agents.']],
  'Half marathon training': [['Health', '12 Oct', 'Long run', '18 km at an easy pace.']],
  'Sleep tracking': [['Health', '14 Oct', 'Sleep', 'Seven hours a night this week.']],
  'Plant-based cooking': [['Notes', '5 Oct', 'Lentil curry', 'Recipe saved from a friend.']],
};
const REBUILD = {
  work: { line: 'Evaluation harnesses', ref: ['Memory', 'Today', 'Saved memory', 'Drafted eval harness notes with Tomas.'], change: ['Memory', 'Today', 'Saved memory', 'Shared the memory draft with Priya.'] },
};
const CARD_SECTIONS = ['Working on', 'Interests', 'Can help with', 'Looking for'];
const TOPIC_TONES = ['pink', 'cyan', 'amber', 'accent', 'violet'];
function topicTone(t) { let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TOPIC_TONES[h % TOPIC_TONES.length]; }
function sectionOf(c, t) { if (c.sec && c.sec[t]) return c.sec[t]; const i = c.topics.indexOf(t); return CARD_SECTIONS[i < 2 ? 0 : Math.min(i - 1, 3)]; }
const ctag = (t, muted) => `<span class="ctag tone-${topicTone(t)}${muted ? ' muted' : ''}"><i></i>${esc(t)}</span>`;
const SOURCE_READ = { Memory: '2 min ago', Papers: '1 h ago', Calendar: '10 min ago', Gmail: '25 min ago', Health: '1 h ago', Notes: 'Yesterday' };
const SOURCE_TINT = { Memory: '#847ac4', Papers: '#e8590c', Calendar: '#e5484d', Gmail: '#2563eb', Health: '#f83e9c', Notes: '#d9a00b' };
function macCard() { const list = walletList(); return list.find((c) => c.id === S.active) || list[0] || null; }
function refsOf(c, t) {
  c.refs = c.refs || {};
  if (!c.refs[t]) c.refs[t] = clone(REFS[t] || [[(c.sources || ['Memory'])[0], '16 Oct', 'Notes', `${t} came up in your notes.`]]);
  return c.refs[t];
}
function renderMac() {
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
function scardInner(c, opts = {}) {
  const n = visibleTopics(c).length;
  const foot = S.building === c.id ? '<i class="spin"></i>Building' : c.suggested ? 'Suggested' : n ? `${n} topics` : 'Not built';
  const open = opts.open && !c.suggested && c.topics.length ? `<span class="sc-open" role="button" aria-label="Open ${esc(c.name)}">Open</span>` : '';
  return `<span class="sc-head"><span class="sc-glyph">${ic(c.kind)}</span><span class="sc-name">${esc(c.name)}</span>${open}</span>
    <span class="sc-focus">${esc(c.focus || '')}</span><span class="sc-foot"><span>${foot}</span>${bird()}</span>`;
}
function syncTiles(instant) {
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
function layoutDeck() {
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
function buildBlock(c) {
  return `<div class="mc-empty"><span class="mc-emptycard" data-kind="${c.kind}"><span class="sc-glyph">${ic(c.kind)}</span></span><h2>${esc(c.name)}</h2><p>Your agent writes it</p><button class="mbtn prim" data-build="${esc(c.id)}">Build</button></div>`;
}
function roomRowMac(r) {
  const trail = r.open ? `<span class="chev">${ic('chev')}</span>` : '';
  return `<div class="m-row room${r.open ? '' : ' closed'}" data-roomrow="${r.id}">${roomLead(r)}<span class="grow"><div class="tt">${esc(r.name)}</div><div class="sub">${esc(roomSub(r))}</div></span>${trail}</div>`;
}
function pendingHTML() {
  const r = S.pending && S.rooms.find((x) => x.id === S.pending); const c = activeCard();
  if (!r || !c) return '';
  const sugg = S.cards.find((x) => x.kind === r.kind && x.topics.length);
  const chip = sugg && sugg.id !== c.id ? `<button class="sugchip" id="pcSugg" title="Share ${esc(sugg.name)} and join"><span class="mini" data-kind="${sugg.kind}"></span>Suggested: ${esc(sugg.name)}</button>` : '';
  return `<div class="pc-confirm"><span class="grow"><div class="tt">${esc(r.name)}</div><div class="sub">${esc(KINDS[r.kind].label)} · ${r.people} people</div></span>${chip}<button class="mbtn tint" id="pcJoin" title="Join sharing ${esc(c.name)}"><span class="mini" data-kind="${c.kind}"></span>Join</button></div>`;
}
function homeHTML() {
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
function subHTML(c) {
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
function macRefresh(opts = {}) {
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
function openSub(id) {
  if (!cardById(id) || !cardById(id).topics.length) return;
  S.active = id; S.sub = id; S.renaming = false; S.lastJump = null;
  renderChip(true); macRefresh({ push: 'push' }); syncURL();
  $('#mgAct').scrollTop = 0;
}
function closeSub() {
  S.sub = null; S.renaming = false; S.fresh = null; S.lastJump = null;
  macRefresh({ push: 'pop' }); syncURL();
}
function macSelect(id) {
  if (id === 'suggest' || id === S.active) return;
  S.active = id; S.renaming = false; S.lastJump = null;
  if (S.sub) S.sub = cardById(id).topics.length ? id : null;
  S.fresh = null;
  renderChip(true); macRefresh(); syncURL();
}
function macJoinPending() {
  const r = S.pending && S.rooms.find((x) => x.id === S.pending); const c = activeCard();
  if (!r || !c) return;
  joinRoom(r, c); S.lastJump = null;
  macRefresh(); syncURL();
  toast(`Sharing ${c.name} in ${r.name}`);
}
function onMacClick(e) {
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
function macSaveRename() {
  if (!S.renaming) return;
  const c = cardById(S.sub) || activeCard(); const v = $('#mcName')?.value.trim();
  if (v) c.name = v;
  S.renaming = false;
  renderChip(); macRefresh();
}
function macRebuild(id) {
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
function macBuild(id) {
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

function createMac() {
  const sh = S.sheet;
  sh.anchor = sh.anchor || $('#pcCreate');
  showLayer(`<div class="m-popcatch" id="dim"></div><div class="m-pop createpop" id="mpop" role="dialog" aria-label="Create a code"></div>`, (l) => {
    $('#dim', l).addEventListener('click', () => closeLayer());
    bindCreate(l);
  });
  paintCreateMac();
}
function paintCreateMac(swap) {
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
function placePop() {
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
function macNew(opts) {
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
function paintNew(swap, noFocus) {
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

// ---------- screens ----------
const PICKS_IOS = [
  ['Wallet', [['wallet', 'Home wallet'], ['fanned', 'Wallet fanned out'], ['detail', 'Card detail']]],
  ['Pair code', [['room', 'Join with a code'], ['create', 'Create a code'], ['code', 'New code']]],
  ['Create', [['new', 'New card'], ['empty', 'Empty wallet, first run']]],
  ['States', [['kaust', 'Custom card named KAUST']]],
];
const MAC_SCREENS = [['wallet', 'Home'], ['detail', 'Card page with references'], ['room', 'Join with a code'], ['create', 'Create a code'], ['code', 'New code'], ['new', 'New card'], ['empty', 'Empty, first run'], ['kaust', 'Custom card named KAUST']];
const PICKS_MAC = [['Mac', MAC_SCREENS]];
const PRESET = {
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
function currentKey() {
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
function jump(key) {
  if (key.includes(':')) key = key.split(':').pop();
  if (key === 'choose') key = 'room';
  if (S && S.mode === 'mac' && key === 'fanned') key = 'wallet';
  timers.forEach(clearTimeout); timers = [];
  S = freshState(S ? S.mode : 'ios');
  const after = PRESET[key] ? PRESET[key]() : null;
  S.lastJump = key;
  render();
  if (typeof after === 'function') after();
  if (key === 'room' && ios()) { instantOn(); }
  syncPick(); syncURL();
}
function render() { if (ios()) renderIOS(); else renderMac(); }
function fillPick() {
  const picks = S && S.mode === 'mac' ? PICKS_MAC : PICKS_IOS;
  $('#pick').innerHTML = '<option value="" disabled>Screen</option>' + picks.map(([g, opts]) => `<optgroup label="${esc(g)}">${opts.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
}
function syncPick() { $('#pick').value = currentKey(); }
function isDark() { return document.documentElement.dataset.theme === 'dark'; }
function syncURL() {
  if (!S) return;
  syncPick();
  const q = new URLSearchParams({ screen: currentKey(), mode: S.mode });
  q.set('theme', isDark() ? 'dark' : 'light');
  try { history.replaceState(null, '', '?' + q.toString()); } catch { /* file URLs */ }
}
const HINTS = {
  ios: 'Tap the stack to fan the cards out, then tap a card to share it. The more button on the front card flips it.',
  mac: 'Click a card to share it. Open on the selected card shows its page.',
};
function fitMac() {
  const narrow = window.innerWidth < 640; const mac = S.mode === 'mac';
  $('#macwrap').hidden = !mac || narrow; $('#macnote').hidden = !mac || !narrow;
  if (!mac || narrow) return;
  const k = Math.min(1, (window.innerWidth - 32) / MAC_W);
  $('#mac').style.transform = `scale(${k})`;
  $('#macwrap').style.width = Math.round(MAC_W * k) + 'px'; $('#macwrap').style.height = Math.round(MAC_H * k) + 'px';
}
function setMode(mode, key) {
  S = S || freshState(mode);
  S.mode = mode;
  $('#modeIos').setAttribute('aria-pressed', mode === 'ios'); $('#modeMac').setAttribute('aria-pressed', mode === 'mac');
  $('#phone').hidden = mode !== 'ios';
  if (mode === 'ios') $('#mac').innerHTML = ''; else $('#screen').innerHTML = '';
  $('#hint').textContent = HINTS[mode];
  fillPick(); fitMac();
  jump(key || currentKey());
}
function paintThemeBtn() { $('#themeBtn').innerHTML = ic(isDark() ? 'sun' : 'moon'); $('#themeBtn').title = isDark() ? 'Light' : 'Dark'; }

// ---------- boot ----------
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#themeBtn').addEventListener('click', () => { document.documentElement.dataset.theme = isDark() ? 'light' : 'dark'; paintThemeBtn(); syncURL(); });
$('#modeIos').addEventListener('click', () => { if (S.mode !== 'ios') setMode('ios'); });
$('#modeMac').addEventListener('click', () => { if (S.mode !== 'mac') setMode('mac'); });
$('#pick').addEventListener('change', (e) => { if (e.target.value) jump(e.target.value); });
window.addEventListener('resize', fitMac);
paintThemeBtn();
const startKey = PRESET[params.get('screen')] ? params.get('screen') : 'wallet';
setMode(params.get('mode') === 'mac' ? 'mac' : 'ios', startKey);
