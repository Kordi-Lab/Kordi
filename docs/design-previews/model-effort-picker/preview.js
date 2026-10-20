'use strict';
// Illustrative fixtures only: model names, levels, accounts and the conversation
// are sample data. Production code must use the shared discovered catalog.
const CHATGPT_LEVELS = ['Light', 'Standard', 'Extended', 'Heavy'];
const models = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', short: '6.1 Sol', provider: 'ChatGPT', levels: CHATGPT_LEVELS, fallback: 'Standard' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', short: '6 Astra', provider: 'ChatGPT', levels: [...CHATGPT_LEVELS, 'Max'], fallback: 'Standard' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', short: '6 Sol', provider: 'ChatGPT', levels: CHATGPT_LEVELS, fallback: 'Standard' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', short: '6 Luna', provider: 'ChatGPT', levels: CHATGPT_LEVELS, fallback: 'Standard' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', short: '5.6 Sol', provider: 'ChatGPT', levels: CHATGPT_LEVELS, fallback: 'Standard' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', short: 'Fable 5.1', provider: 'Claude', levels: ['Low', 'Medium', 'High', 'Max'], fallback: 'Medium' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', short: 'Sonnet 5', provider: 'Claude', levels: ['Off', 'Low', 'Medium', 'High', 'Max'], fallback: 'Medium' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', short: '3.1 Pro', provider: 'Gemini', levels: ['Low', 'Medium', 'High'], fallback: 'Medium' },
];
const QUICK = [0, 1, 2, 3, 4]; // ChatGPT rows in the short list, in this order.
const ACCOUNTS = ['Work', 'Personal'];
const $ = (selector) => document.querySelector(selector);
const routes = Object.fromEntries(['group', 'session', 'thread'].map(s => [s, { model: 0, effort: 'Light', account: 'Work', unavailable: false, inherit: false }]));
let scope = 'group';
let view = null;            // null | effort | models | all | accounts | confirm
let pending = null;
let accountModel = null;
let originTrigger = 'effort-trigger';
let iosExpanded = false;
let keyboardUp = false;
const win = $('#app-window');
const isIOS = () => win.classList.contains('ios');
const current = () => routes[scope];
const model = () => models[current().model];
const shared = () => scope !== 'session';
const container = () => isIOS() ? $('#ios-panel') : $('#popover');

function announce(message) { $('#notice').textContent = message; $('#live').textContent = message; }

// ---------- Pill ----------
function syncRoute(animate = false) {
  const route = current();
  const name = route.unavailable ? 'Account unavailable' : route.inherit ? 'Default' : model().short;
  for (const [pill, m, e] of [['#model-pill', '#model-trigger', '#effort-trigger'], ['#ios-pill', '#ios-model-trigger', '#ios-effort-trigger']]) {
    const changed = $(m).textContent !== name || $(e).textContent !== route.effort;
    $(m).textContent = name;
    $(e).textContent = route.effort;
    $(pill).classList.toggle('unavailable', route.unavailable);
    $(m).setAttribute('aria-label', `${route.unavailable ? 'Account unavailable. ' : ''}Select model, current ${route.inherit ? 'Default, ' : ''}${model().name}`);
    $(e).setAttribute('aria-label', `Adjust effort, current ${route.effort}`);
    $(m).setAttribute('aria-expanded', String(view !== null && view !== 'effort'));
    $(e).setAttribute('aria-expanded', String(view === 'effort'));
    if (animate && changed) { $(pill).classList.remove('swap'); void $(pill).offsetWidth; $(pill).classList.add('swap'); }
  }
  $('#unavailable').checked = route.unavailable;
}

// ---------- Slider ----------
function sliderHTML(kind) {
  const levels = model().levels;
  const index = Math.max(0, levels.indexOf(current().effort));
  const t = levels.length > 1 ? index / (levels.length - 1) : 0;
  return `<div class="slider ${kind}-slider" role="slider" tabindex="0" aria-label="Thinking effort" aria-valuemin="0" aria-valuemax="${levels.length - 1}" aria-valuenow="${index}" aria-valuetext="${current().effort}" style="--t:${t}"><div class="slider-fill"></div><div class="slider-dots">${levels.map((_, i) => `<i class="${i < index ? 'on' : ''} ${i === index ? 'at' : ''}"></i>`).join('')}</div><div class="slider-thumb"></div></div>`;
}
function setEffortIndex(index) {
  const levels = model().levels;
  index = Math.min(levels.length - 1, Math.max(0, index));
  if (levels[index] === current().effort && !current().inherit) return;
  current().effort = levels[index];
  const slider = container().querySelector('.slider');
  if (slider) {
    slider.style.setProperty('--t', levels.length > 1 ? index / (levels.length - 1) : 0);
    slider.setAttribute('aria-valuenow', index);
    slider.setAttribute('aria-valuetext', levels[index]);
    slider.querySelectorAll('.slider-dots i').forEach((dot, i) => { dot.classList.toggle('on', i < index); dot.classList.toggle('at', i === index); });
  }
  container().querySelectorAll('[data-effort-label]').forEach(el => { el.textContent = levels[index]; });
  syncRoute(true);
  announce(`${levels[index]} effort applied`);
}
function indexFromPointer(slider, clientX) {
  const rect = slider.getBoundingClientRect();
  const inset = slider.classList.contains('ios-slider') ? 28 : 12;
  const t = (clientX - rect.left - inset) / Math.max(1, rect.width - inset * 2);
  return Math.round(Math.min(1, Math.max(0, t)) * (model().levels.length - 1));
}
document.addEventListener('pointerdown', event => {
  const slider = event.target.closest('.slider');
  if (!slider) return;
  event.preventDefault();
  slider.setPointerCapture(event.pointerId);
  setEffortIndex(indexFromPointer(slider, event.clientX));
  const move = e => setEffortIndex(indexFromPointer(slider, e.clientX));
  const up = () => { slider.removeEventListener('pointermove', move); slider.removeEventListener('pointerup', up); slider.removeEventListener('pointercancel', up); };
  slider.addEventListener('pointermove', move); slider.addEventListener('pointerup', up); slider.addEventListener('pointercancel', up);
}, true);
document.addEventListener('keydown', event => {
  const slider = event.target.closest?.('.slider');
  if (!slider) return;
  const index = Number(slider.getAttribute('aria-valuenow'));
  const next = { ArrowRight: index + 1, ArrowUp: index + 1, ArrowLeft: index - 1, ArrowDown: index - 1, Home: 0, End: model().levels.length - 1 }[event.key];
  if (next !== undefined) { event.preventDefault(); setEffortIndex(next); }
});

// ---------- Picker content ----------
function header(title, back = 'models') {
  return `<div class="pop-header"><button class="icon-button" data-view="${back}" aria-label="Back">‹</button><h2>${title}</h2><button class="icon-button" data-close aria-label="Close picker">×</button></div>`;
}
function modelRow(item, index) {
  const selected = !current().inherit && current().model === index;
  return `<button class="row" data-model="${index}" aria-pressed="${selected}"><span>${item.name}</span>${selected ? '<span class="check" aria-hidden="true">✓</span>' : ''}</button>`;
}
function accountRow() {
  const route = current();
  return `<button class="row secondary" data-accounts="${route.model}">${route.unavailable ? 'Account unavailable' : `${model().provider} • ${route.account}`}<span class="right">›</span></button>`;
}
function render() {
  const panel = container();
  const other = isIOS() ? $('#popover') : $('#ios-panel');
  other.hidden = true;
  panel.hidden = !view;
  panel.classList.toggle('popover--effort', view === 'effort');
  $('#ios-backdrop').classList.toggle('open', isIOS() && !!view);
  win.classList.toggle('panel-open', isIOS() && !!view);
  if (!view) return;
  const route = current();
  if (view === 'effort') {
    panel.setAttribute('aria-label', 'Thinking effort');
    panel.innerHTML = isIOS()
      ? `<button class="ios-effort-head" data-view="models" aria-label="Change model, current ${model().name}"><span class="name">${route.inherit ? 'Default' : model().short}</span><span class="lvl" data-effort-label>${route.effort}</span><span class="chev" aria-hidden="true">›</span></button>${sliderHTML('ios')}`
      : `<div class="mac-effort-head"><div class="titles"><div class="effort-title" data-effort-label>${route.effort}</div><button class="model-link" data-view="models">${route.inherit ? 'Default' : model().name} ›</button></div><button class="icon-button" data-reset aria-label="Reset effort to model default" title="Reset to model default">↺</button></div>${sliderHTML('mac')}`;
  } else if (view === 'models' || view === 'all') {
    panel.setAttribute('aria-label', 'Select model');
    const rows = view === 'all' ? models.map((m, i) => i) : [...QUICK, ...(QUICK.includes(route.model) ? [] : [route.model])];
    panel.innerHTML = `${view === 'all' ? header('All models') : '<div class="pop-header"><h2>Select model</h2><button class="icon-button" data-close aria-label="Close picker">×</button></div>'}${route.unavailable ? '<div class="warning">Account unavailable. Choose a signed-in account to use this model.</div>' : ''}${view === 'all' ? '<input class="search" type="search" placeholder="Find a model…" aria-label="Find a model">' : `<button class="row" data-default aria-pressed="${route.inherit}"><span>Default<span class="sub">${models[0].name}</span></span>${route.inherit ? '<span class="check" aria-hidden="true">✓</span>' : ''}</button>`}<div class="model-list">${rows.map(i => modelRow(models[i], i)).join('')}</div>${view === 'models' ? '<button class="row secondary" data-view="all">More models<span class="right">›</span></button>' : ''}<div class="rule"></div>${accountRow()}`;
  } else if (view === 'accounts') {
    const nextModel = models[accountModel ?? route.model];
    panel.setAttribute('aria-label', 'Choose account');
    panel.innerHTML = `${header(nextModel.provider + ' account')}<p class="account-note">${nextModel.name}</p>${route.unavailable && nextModel.provider === model().provider ? '<div class="warning">The previous account was removed. Select a signed-in account from the same provider.</div>' : ''}${ACCOUNTS.map(account => `<button class="row" data-account="${account}"><span>${account}<span class="sub">Signed in · ${nextModel.provider}</span></span>${account === route.account && !route.unavailable && nextModel.provider === model().provider ? '<span class="check" aria-hidden="true">✓</span>' : ''}</button>`).join('')}<p class="account-note">${shared() ? 'Changing the group’s account requires confirmation.' : 'Applies to this agent session.'}</p>`;
  } else if (view === 'confirm') {
    panel.setAttribute('aria-label', 'Change shared account');
    panel.innerHTML = `${header('Change shared account?', 'accounts')}<p class="confirm-copy">Future agent replies ${scope === 'thread' ? 'in this thread' : 'in Design team'} will use this account for everyone.</p><div class="confirm-route">${models[pending.model].provider} • ${pending.account}<br><span class="sub">${models[pending.model].name} · ${pending.effort}</span></div><p class="account-note">The current reply, if any, keeps its existing route.</p><div class="confirm-actions"><button data-cancel>Cancel</button><button class="primary" data-confirm>Change account</button></div>`;
  }
  if (isIOS() && view !== 'effort') {
    // Pin the title row; only the rows beneath it scroll.
    const scroller = document.createElement('div');
    scroller.className = 'panel-scroll';
    [...panel.children].filter(el => !el.classList.contains('pop-header')).forEach(el => scroller.append(el));
    panel.append(scroller);
  }
  panel.classList.toggle('centered', isIOS() && view !== 'effort');
  layoutIOS();
}
function open(next, focus = false) {
  view = next;
  render();
  syncRoute();
  if (focus) container().querySelector('input, [role=slider], button')?.focus();
  updateURL();
}
function close(restoreFocus = true) {
  view = null; pending = null; accountModel = null;
  render(); syncRoute(); updateURL();
  if (restoreFocus && !isIOS()) document.getElementById(originTrigger)?.focus();
  // iPhone: the screen returns with the field still focused and the keyboard up.
  if (isIOS() && keyboardUp) input.focus({ preventScroll: true });
}
function apply(next) {
  routes[scope] = next;
  syncRoute(true);
  announce(`${next.inherit ? 'Default' : models[next.model].name} · ${next.effort} applied`);
  close();
}
function pickModel(index, inherit = false) {
  const route = current();
  const next = { ...route, model: index, inherit };
  if (!models[index].levels.includes(next.effort)) next.effort = models[index].fallback;
  if (models[index].provider !== model().provider) { pending = next; accountModel = index; open('accounts'); }
  else apply(next);
}
for (const panel of [$('#popover'), $('#ios-panel')]) {
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const keyboard = event.detail === 0;
    if (button.hasAttribute('data-close')) return close();
    if (button.dataset.view) return open(button.dataset.view, keyboard);
    if (button.hasAttribute('data-reset')) { setEffortIndex(model().levels.indexOf(model().fallback)); announce('Effort reset to model default'); return; }
    if (button.dataset.model !== undefined) return pickModel(Number(button.dataset.model));
    if (button.hasAttribute('data-default')) return pickModel(0, true);
    if (button.dataset.accounts !== undefined) { accountModel = Number(button.dataset.accounts); pending = null; return open('accounts', keyboard); }
    if (button.dataset.account) {
      const next = { ...(pending ?? current()), model: accountModel ?? current().model, account: button.dataset.account, unavailable: false };
      const changed = next.account !== current().account || models[next.model].provider !== model().provider || current().unavailable;
      if (shared() && changed) { pending = next; return open('confirm', keyboard); }
      return apply(next);
    }
    if (button.hasAttribute('data-cancel')) return close();
    if (button.hasAttribute('data-confirm') && pending) return apply(pending);
  });
  // Pointer taps inside the iPhone panel keep focus in the field (except the search box).
  panel.addEventListener('pointerdown', event => { if (isIOS() && event.target.type !== 'search') event.preventDefault(); });
  panel.addEventListener('input', event => {
    if (event.target.type !== 'search') return;
    const q = event.target.value.toLowerCase();
    const matches = models.map((item, index) => ({ item, index })).filter(({ item }) => `${item.name} ${item.provider}`.toLowerCase().includes(q));
    panel.querySelector('.model-list').innerHTML = matches.length ? matches.map(({ item, index }) => modelRow(item, index)).join('') : '<p class="account-note" role="status">No models found. Try another name.</p>';
  });
}
// Mac triggers
$('#model-trigger').onclick = (e) => { originTrigger = 'model-trigger'; accountModel = null; pending = null; view === 'models' ? close() : open('models', e.detail === 0); };
$('#effort-trigger').onclick = (e) => { originTrigger = 'effort-trigger'; pending = null; accountModel = null; view === 'effort' ? close() : open('effort', e.detail === 0); };
document.addEventListener('pointerdown', event => {
  if (isIOS() || !view) return;
  if (!event.target.closest('.route-anchor') && !event.target.closest('.review-controls')) close(false);
});
document.addEventListener('keydown', event => {
  if (!view) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key === 'Tab') {
    const controls = [...container().querySelectorAll('button,input,[role=slider]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

// ---------- iPhone composer ----------
const field = $('#ios-field');
const input = $('#ios-input');
const KEYS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
$('#ios-keyboard').innerHTML = KEYS.map((row, r) => `<div class="kb-row">${r === 2 ? '<button class="wide" data-key="shift" aria-label="Shift">⇧</button>' : ''}${[...row].map(k => `<button data-key="${k}">${k}</button>`).join('')}${r === 2 ? '<button class="wide" data-key="back" aria-label="Delete">⌫</button>' : ''}</div>`).join('') + '<div class="kb-row"><button class="wide" data-key="num">123</button><button class="space" data-key=" ">space</button><button class="done" data-key="done">Done</button></div>';

function layoutIOS() {
  if (!isIOS()) return;
  const conv = $('#conversation').getBoundingClientRect();
  const f = field.getBoundingClientRect();
  const head = $('.chat-header').getBoundingClientRect();
  const fieldTop = f.top - conv.top;
  // The backdrop is a full-screen layer (CSS inset: 0); only the panel is positioned.
  const panel = $('#ios-panel');
  if (panel.classList.contains('centered')) { panel.style.bottom = ''; panel.style.maxHeight = ''; return; }
  panel.style.bottom = `${conv.bottom - f.top + 24}px`;
  panel.style.maxHeight = `${Math.max(120, fieldTop - (head.bottom - conv.top) - 36)}px`;
}
function relayout(ms = 260) {
  const end = performance.now() + ms;
  const step = () => { layoutIOS(); if (performance.now() < end) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function scrollTranscript() {
  const m = $('#messages');
  // Leave the last lines just behind the glass field so the strip reads as transparent.
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight - m.clientHeight - 36; });
}
function setDraftUI() {
  const has = input.value.trim().length > 0;
  $('#ios-send').classList.toggle('has-draft', has);
  $('#ios-send').setAttribute('aria-label', has ? 'Send unavailable in this preview' : 'Voice mode unavailable in this preview');
}
function setIOS({ expanded = iosExpanded, keyboard = keyboardUp } = {}) {
  iosExpanded = expanded; keyboardUp = keyboard;
  field.classList.toggle('expanded', expanded);
  win.classList.toggle('kb-up', keyboard);
  $('#messages').style.paddingBottom = isIOS() ? `${(keyboard ? 262 + 8 : 30) + (expanded ? 96 : 48) - 12}px` : '';
  relayout(); updateURL();
}
function blurIOS() {
  input.blur();
  setIOS({ expanded: input.value.trim().length > 0, keyboard: false });
}
input.addEventListener('focus', () => { if (isIOS()) { setIOS({ expanded: true, keyboard: true }); scrollTranscript(); } });
input.addEventListener('input', () => { setDraftUI(); updateURL(); });
// Controls inside the field keep the text focus, like the native composer.
field.addEventListener('pointerdown', event => { if (event.target !== input) event.preventDefault(); });
$('#ios-keyboard').addEventListener('pointerdown', event => {
  event.preventDefault();
  const key = event.target.closest('[data-key]')?.dataset.key;
  if (!key) return;
  if (key === 'done') return blurIOS();
  if (key === 'back') input.value = input.value.slice(0, -1);
  else if (key.length === 1) input.value += key;
  setDraftUI();
});
$('#ios-model-trigger').onclick = (e) => view === 'models' ? close() : open('models', e.detail === 0);
$('#ios-effort-trigger').onclick = (e) => view === 'effort' ? close() : open('effort', e.detail === 0);
$('#ios-backdrop').addEventListener('pointerdown', event => { event.preventDefault(); close(); });
$('#ios-send').addEventListener('click', () => announce(input.value.trim() ? 'Sending is off in this preview' : 'Voice mode is off in this preview'));
for (const area of [$('#messages'), $('.chat-header')]) area.addEventListener('pointerdown', () => { if (isIOS() && !view && (iosExpanded || keyboardUp)) blurIOS(); });
new ResizeObserver(() => layoutIOS()).observe($('#conversation'));

// ---------- Review controls ----------
function setDevice(device) {
  document.querySelectorAll('[data-device]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.device === device)));
  view = null; pending = null; accountModel = null;
  win.classList.toggle('ios', device === 'ios');
  win.classList.remove('show-list');
  input.blur(); input.value = ''; setDraftUI();
  setIOS({ expanded: false, keyboard: false });
  render(); syncRoute(); scrollTranscript(); updateURL();
}
document.querySelectorAll('[data-device]').forEach(button => button.onclick = () => setDevice(button.dataset.device));
$('#palette').onchange = () => { document.body.dataset.kordiChatTheme = $('#palette').value; updateURL(); };
$('#theme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').innerHTML = `◐ <span>${dark ? 'Light' : 'Dark'}</span>`;
  $('#theme').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
  updateURL();
};
$('#context').onchange = () => {
  scope = $('#context').value;
  pending = null; accountModel = null;
  const labels = { group: ['Design team', 'You, Mira, and Kordi', 'Applies to this group’s agent'], session: ['Kordi agent', 'Agent session', 'Applies to this session'], thread: ['Model picker review', 'Thread in Design team', 'Applies to this thread’s agent'] }[scope];
  $('#chat-title').textContent = labels[0]; $('#chat-subtitle').textContent = labels[1]; $('#scope-note').textContent = labels[2];
  $('#header-avatar').textContent = scope === 'session' ? 'K' : 'D';
  for (const t of [$('#mac-input'), input]) t.placeholder = `Message ${labels[0]}…`;
  $('#messages').style.visibility = scope === 'session' ? 'hidden' : 'visible';
  announce(''); syncRoute(); if (view) render(); updateURL();
};
$('#unavailable').onchange = () => {
  current().unavailable = $('#unavailable').checked;
  accountModel = null; pending = null; syncRoute(); announce('');
  if (view) render();
  updateURL();
};
function currentState() {
  if (win.classList.contains('show-list')) return 'projects';
  if (view === 'effort') return 'effort';
  if (view === 'models' || view === 'all') return 'models';
  if (isIOS() ? iosExpanded : document.activeElement === $('#mac-input')) return 'typing';
  return 'idle';
}
let ready = false;
function updateURL() {
  if (!ready) return;
  const params = new URLSearchParams({ device: isIOS() ? 'ios' : 'mac', theme: document.documentElement.dataset.theme ?? 'light', context: scope, palette: $('#palette').value });
  if (current().unavailable) params.set('unavailable', '1');
  const state = currentState();
  if (state !== 'idle') params.set('state', state);
  history.replaceState(null, '', `?${params}`);
}
$('#mac-input').addEventListener('focus', updateURL);
$('#mac-input').addEventListener('blur', updateURL);

// ---------- Initial state from the URL ----------
const params = new URLSearchParams(location.search);
win.classList.add('no-anim');
if (['default', 'ocean', 'midnight', 'sand'].includes(params.get('palette'))) { $('#palette').value = params.get('palette'); $('#palette').onchange(); }
setDevice(params.get('device') === 'ios' ? 'ios' : 'mac');
if (params.get('theme') === 'dark') $('#theme').click();
if (['group', 'session', 'thread'].includes(params.get('context'))) { $('#context').value = params.get('context'); $('#context').onchange(); }
if (params.get('unavailable') === '1') { current().unavailable = true; syncRoute(); }
const state = params.get('state');
const sample = 'Looks good, one more pass on the slider';
if (state === 'projects' && isIOS()) win.classList.add('show-list');
else if (state === 'typing' || state === 'effort' || state === 'models') {
  if (isIOS()) {
    if (state === 'typing') input.value = sample;
    setDraftUI();
    setIOS({ expanded: true, keyboard: true });
    if (state === 'typing') input.focus({ preventScroll: true });
  } else if (state === 'typing') { $('#mac-input').value = sample; $('#mac-input').focus({ preventScroll: true }); }
  if (state === 'effort' || state === 'models') { originTrigger = state === 'effort' ? 'effort-trigger' : 'model-trigger'; view = state; render(); }
}
syncRoute(); render(); scrollTranscript();
requestAnimationFrame(() => requestAnimationFrame(() => { win.classList.remove('no-anim'); layoutIOS(); }));
ready = true; updateURL();
