// Card markup, the shell, the iPhone wallet, layers and the carousel.
import { $, $$, esc, reduced, DUR, later, ic, bird, S, cardById, activeCard, walletList, ios, geo } from './core.js';
import { MAX_CARDS, BUILT } from './data.js';
import { renderBelow, openNew, openDetail } from './ios.js';
import { macBuild } from './mac.js';
import { syncURL } from './app.js';

// ---------- card markup ----------
export function visibleTopics(c) { return (c.topics || []).filter((t) => !(c.hidden || []).includes(t)).slice(0, 5); }
export function topicsHTML(c, opts = {}) {
  if (S.building === c.id) return '<span class="gc-build busy"><i class="spin"></i>Building</span>';
  const ts = visibleTopics(c);
  if (ts.length) return ts.map((t, i) => `<span class="gc-topic${opts.pop ? ' pop' : ''}" style="${opts.pop ? `animation-delay:${i * 60}ms` : ''}">${esc(t)}</span>`).join('');
  if (opts.skeleton) return ['70px', '96px', '58px'].map((w) => `<span class="gc-topic skel" style="--w:${w}">.</span>`).join('');
  return `<button class="gc-build" data-build="${esc(c.id)}">Build</button>`;
}
export function cardInner(c, opts = {}) {
  return `<div class="gc-head"><span class="gc-glyph">${ic(c.kind)}</span><span class="gc-name">${esc(c.name)}</span>${opts.flip ? `<button class="gc-flip" aria-label="Card details" tabindex="-1">${ic('flip')}</button>` : ''}<span class="gc-check" aria-hidden="true">${ic('check')}</span></div>
    <div class="gc-focus">${esc(c.suggested ? 'Suggested' : c.focus || '')}</div>
    <div class="gc-topics">${topicsHTML(c, opts)}</div>${bird()}`;
}
export const cardHTML = (c, opts = {}) => `<div class="gcard${opts.cls ? ' ' + opts.cls : ''}" data-kind="${c.kind}" data-id="${esc(c.id)}">${cardInner(c, opts)}</div>`;

// ---------- shell ----------
export const avatar = (p, size) => `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(p.initials)}</span>`;
export function chipHTML() {
  const c = S.suggest && !S.cards.length ? null : activeCard();
  if (!c) return '<div class="sharechip is-empty" id="chip"></div>';
  return `<div class="sharechip" id="chip"><span class="sw8" data-kind="${c.kind}"></span><span>Sharing: <b>${esc(c.name)}</b></span></div>`;
}
export function renderIOS() {
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
export function renderChip(swap) {
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
export function mountWallet() {
  const w = $('#wallet');
  w.innerHTML = `<button class="gplus" id="gplus">${ic('plus')}New card</button>`;
  syncWalletCards(true);
  w.addEventListener('click', onWalletClick);
  w.addEventListener('keydown', (e) => {
    const card = e.target.closest('.gcard');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onWalletCard(card, e); }
  });
}
export function syncWalletCards(instant) {
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
export function place(el, y, s, z, o) {
  if (!el) return;
  el.style.transform = `translate3d(0, ${y}px, 0) scale(${s})`;
  el.style.zIndex = z; el.style.opacity = o;
}
export function layoutWallet() {
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
export function onWalletClick(e) {
  const b = e.target.closest('[data-build]');
  if (b) { e.stopPropagation(); startBuild(b.dataset.build); return; }
  if (e.target.closest('#gplus')) { openNew(); return; }
  const card = e.target.closest('.gcard');
  if (card) onWalletCard(card, e);
}
export function onWalletCard(card, e) {
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
export function startBuild(id) {
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

// ---------- layers ----------
export function layer() { return $('#layer'); }
export function overlayHost() { return ios() ? $('#screen') : $('#mac'); }
export function closeLayer(after) {
  const l = layer(); if (!l) return;
  $$('.dimmer, .sheet, .m-dim, .m-pop', l).forEach((el) => el.classList.remove('on'));
  later(() => { l.innerHTML = ''; S.sheet = null; if (after) after(); syncURL(); }, DUR());
}
export function showLayer(html, bind) {
  const l = layer();
  l.innerHTML = html;
  if (bind) bind(l);
  void l.offsetWidth;
  requestAnimationFrame(() => $$('.dimmer, .sheet, .m-dim, .m-pop', l).forEach((el) => el.classList.add('on')));
}
export function instantOn() { $$('.dimmer, .sheet, .m-dim, .m-pop', layer()).forEach((el) => { el.style.transition = 'none'; el.classList.add('on'); void el.offsetWidth; el.style.transition = ''; }); }
export function toast(text) {
  const host = overlayHost(); if (!host) return;
  $$('.toast, .m-toast', host).forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = ios() ? 'toast' : 'm-toast';
  t.textContent = text;
  host.appendChild(t);
  later(() => { t.style.opacity = '0'; later(() => t.remove(), 250); }, 2200);
}

// ---------- carousel ----------
export function bindCarousel(car, onSel) {
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
export const dotsHTML = (n, on) => `<div class="dots">${Array.from({ length: n }, (_, i) => `<i class="${i === on ? 'on' : ''}"></i>`).join('')}</div>`;
export function setDots(box, on) { $$('.dots i', box).forEach((d, i) => d.classList.toggle('on', i === on)); }
export const suggHTML = () => `<div class="sugg"><span>${ic('sparkle')}Suggested for this room</span></div>`;
