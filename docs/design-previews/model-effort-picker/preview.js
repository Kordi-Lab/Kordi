'use strict';
// Model identifiers and effort constraints mirror AgentModelSheet.swift at proposal time.
// Conversation, account labels, and default route are illustrative fixtures only.
const models = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'OpenAI', levels: ['Low', 'Medium', 'High', 'Extra high', 'Max'] },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', provider: 'OpenAI', levels: ['Low', 'Medium', 'High', 'Extra high', 'Max'] },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'OpenAI', levels: ['Low', 'Medium', 'High', 'Extra high', 'Max'] },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'Anthropic', levels: ['Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'] },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'Anthropic', levels: ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'OpenAI', levels: ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'Google', levels: ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'] },
];
const $ = (selector) => document.querySelector(selector);
const routes = Object.fromEntries(['group', 'session', 'thread'].map(scope => [scope, { model: 0, effort: 'High', account: 'Team account', unavailable: false, inherit: false }]));
let scope = 'group';
let view = 'effort';
let pending = null;
let originTrigger = 'effort-trigger';
let accountModel = null;
const popover = $('#popover');
const current = () => routes[scope];
const model = () => models[current().model];
const shared = () => scope !== 'session';
function announce(message) { $('#notice').textContent = message; }
function syncRoute() {
  const route = current();
  $('#model-trigger').textContent = route.unavailable ? 'Account unavailable' : route.inherit ? 'Default' : model().name;
  $('#effort-trigger').innerHTML = `<span>${route.effort === 'Default' ? 'Auto' : route.effort}</span>⌄`;
  $('#model-pill').classList.toggle('unavailable', route.unavailable);
  $('#model-trigger').setAttribute('aria-label', `${route.unavailable ? 'Account unavailable. ' : ''}Select model, current ${route.inherit ? 'Default, ' : ''}${model().name}`);
  $('#effort-trigger').setAttribute('aria-label', `Adjust effort, current ${route.effort}`);
  $('#unavailable').checked = route.unavailable;
  $('#model-trigger').setAttribute('aria-expanded', String(view !== null && view !== 'effort'));
  $('#effort-trigger').setAttribute('aria-expanded', String(view === 'effort'));
}
function open(next, focus = true) {
  view = next;
  render();
  syncRoute();
  if (focus) popover.querySelector('input, button')?.focus();
}
function close() {
  view = null;
  pending = null;
  accountModel = null;
  popover.hidden = true;
  syncRoute();
  document.getElementById(originTrigger).focus();
}
function header(title, back = 'models') {
  return `<div class="pop-header"><button class="icon-button" data-view="${back}" aria-label="Back">‹</button><h2>${title}</h2><button class="icon-button" data-close aria-label="Close picker">×</button></div>`;
}
function modelRow(item, index) {
  const selected = !current().inherit && current().model === index;
  return `<button class="row ${selected ? 'current' : ''}" data-model="${index}" aria-pressed="${selected}"><span class="provider-mark" aria-hidden="true">${item.provider === 'OpenAI' ? 'O' : item.provider === 'Anthropic' ? 'A' : 'G'}</span><span>${item.name}</span>${selected ? '<span class="check">✓</span>' : ''}</button>`;
}
function render() {
  popover.hidden = !view;
  popover.classList.toggle('popover--effort', view === 'effort');
  if (!view) return;
  const route = current();
  if (view === 'effort') {
    const levels = model().levels;
    const isDefault = route.effort === 'Default';
    const index = Math.max(0, levels.indexOf(route.effort));
    popover.setAttribute('aria-label', 'Thinking effort');
    popover.innerHTML = `<div class="effort-head"><div class="effort-center"><div class="effort-title" id="effort-title">${route.effort}</div><button class="model-link" data-view="models">${model().name} ›</button></div><button class="icon-button" data-reset aria-label="Reset effort to model default" title="Reset to model default">↺</button></div><div class="slider-wrap"><div class="slider-fill" style="width:${isDefault ? 0 : 5 + index / (levels.length - 1) * 90}%"></div><div class="slider-dots">${levels.map(() => '<i></i>').join('')}</div><input type="range" min="0" max="${levels.length - 1}" step="1" value="${index}" aria-label="Thinking effort" aria-valuetext="${isDefault ? 'Model default. Move slider to choose a level.' : route.effort}"></div>`;
  } else if (view === 'models' || view === 'all') {
    popover.setAttribute('aria-label', 'Select model');
    popover.innerHTML = `${view === 'all' ? header('All models') : '<div class="pop-header"><h2>Select model</h2><button class="icon-button" data-close aria-label="Close picker">×</button></div>'}${route.unavailable ? '<div class="warning">Account unavailable. Choose a signed-in account to use this model.</div>' : ''}${view === 'all' ? '<input class="search" type="search" placeholder="Find a model…" aria-label="Find a model">' : `<button class="row ${route.inherit ? 'current' : ''}" data-default aria-pressed="${route.inherit}"><span>Default<span class="sub">GPT-6 Astra · model default</span></span>${route.inherit ? '<span class="check">✓</span>' : ''}</button><div class="rule"></div>`}<div class="model-list">${models.map((item, index) => ({ item, index })).filter(({index}) => view === 'all' || index < 4 || index === route.model).map(({item,index}) => modelRow(item,index)).join('')}</div>${view === 'models' ? '<button class="row secondary" data-view="all">More models<span class="right">›</span></button>' : ''}<div class="rule"></div><button class="row secondary" data-accounts="${route.model}">${route.unavailable ? 'Account unavailable' : model().provider + ' · ' + route.account}<span class="right">›</span></button>`;
  } else if (view === 'accounts') {
    const nextModel = models[accountModel ?? route.model];
    popover.setAttribute('aria-label', 'Choose account');
    popover.innerHTML = `${header(nextModel.provider + ' account')}<p class="account-note">${nextModel.name}</p>${route.unavailable && nextModel.provider === model().provider ? '<div class="warning">The previous account was removed. Select a signed-in account from the same provider.</div>' : ''}${['Team account','Personal account'].map(account => `<button class="row" data-account="${account}"><span>${account}<span class="sub">Signed in · ${nextModel.provider}</span></span>${account === route.account && !route.unavailable && nextModel.provider === model().provider ? '<span class="check">✓</span>' : ''}</button>`).join('')}<p class="account-note">${shared() ? 'Changing the group’s account requires confirmation.' : 'Applies to this agent session.'}</p>`;
  } else if (view === 'confirm') {
    popover.setAttribute('aria-label', 'Change shared account');
    popover.innerHTML = `${header('Change shared account?', 'accounts')}<p class="confirm-copy">Future agent replies ${scope === 'thread' ? 'in this thread' : 'in Design team'} will use this account for everyone.</p><div class="confirm-route">${models[pending.model].provider} · ${pending.account}<br><span class="sub">${models[pending.model].name} · ${pending.effort}</span></div><p class="account-note">The current reply, if any, keeps its existing route.</p><div class="confirm-actions"><button data-cancel>Cancel</button><button class="primary" data-confirm>Change account</button></div>`;
  }
}
function apply(next) {
  routes[scope] = next;
  syncRoute();
  announce(`${next.inherit ? 'Default' : models[next.model].name} · ${next.effort} applied`);
  close();
}
function pickModel(index, inherit = false) {
  const route = current();
  const next = { ...route, model: index, inherit, effort: inherit ? 'Default' : route.effort };
  if (next.effort !== 'Default' && !models[index].levels.includes(next.effort)) next.effort = 'Default';
  if (models[index].provider !== model().provider) {
    pending = next;
    accountModel = index;
    open('accounts');
  } else apply(next);
}
$('#model-trigger').onclick = () => { originTrigger = 'model-trigger'; accountModel = null; pending = null; view === 'models' ? close() : open('models'); };
$('#effort-trigger').onclick = () => { originTrigger = 'effort-trigger'; pending = null; accountModel = null; view === 'effort' ? close() : open('effort'); };
popover.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-close')) return close();
  if (button.dataset.view) return open(button.dataset.view);
  if (button.hasAttribute('data-reset')) {
    current().effort = 'Default'; syncRoute(); render();
    popover.querySelector('[data-reset]').focus(); announce('Effort reset to model default'); return;
  }
  if (button.dataset.model !== undefined) return pickModel(Number(button.dataset.model));
  if (button.hasAttribute('data-default')) return pickModel(0, true);
  if (button.dataset.accounts !== undefined) { accountModel = Number(button.dataset.accounts); pending = null; return open('accounts'); }
  if (button.dataset.account) {
    const next = { ...(pending ?? current()), model: accountModel ?? current().model, account: button.dataset.account, unavailable: false };
    const changedAccount = next.account !== current().account || models[next.model].provider !== model().provider || current().unavailable;
    if (shared() && changedAccount) { pending = next; return open('confirm'); }
    return apply(next);
  }
  if (button.hasAttribute('data-cancel')) return close();
  if (button.hasAttribute('data-confirm') && pending) return apply(pending);
});
popover.addEventListener('input', event => {
  if (event.target.type === 'range') {
    current().effort = model().levels[Number(event.target.value)];
    current().inherit = false;
    $('#effort-title').textContent = current().effort;
    event.target.setAttribute('aria-valuetext', current().effort);
    $('.slider-fill').style.width = `${5 + Number(event.target.value) / (model().levels.length - 1) * 90}%`;
    syncRoute(); announce(`${current().effort} effort applied`);
  } else if (event.target.type === 'search') {
    const matches = models.map((item,index) => ({item,index})).filter(({item}) => `${item.name} ${item.provider}`.toLowerCase().includes(event.target.value.toLowerCase()));
    $('.model-list').innerHTML = matches.length ? matches.map(({item,index}) => modelRow(item,index)).join('') : '<p class="account-note" role="status">No models found. Try another name.</p>';
  }
});
document.addEventListener('pointerdown', event => {
  if (view && !event.target.closest('.route-anchor') && !event.target.closest('.review-controls')) { view = null; pending = null; accountModel = null; popover.hidden = true; syncRoute(); }
});
document.addEventListener('keydown', event => {
  if (!view) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key === 'Tab') {
    const controls = [...popover.querySelectorAll('button,input')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
document.querySelectorAll('[data-device]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-device]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
  $('#app-window').classList.toggle('ios', button.dataset.device === 'ios');
  updateURL();
});
$('#palette').onchange = () => {
  document.body.dataset.kordiChatTheme = $('#palette').value;
  updateURL();
};
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
  const labels = { group: ['Design team','You, Mira, and Kordi','Applies to this group’s agent'], session: ['Kordi agent','Agent session','Applies to this session'], thread: ['Model picker review','Thread in Design team','Applies to this thread’s agent'] }[scope];
  $('#chat-title').textContent = labels[0]; $('#chat-subtitle').textContent = labels[1]; $('#scope-note').textContent = labels[2];
  $('#header-avatar').textContent = scope === 'session' ? 'K' : 'D';
  $('textarea').placeholder = `Message ${labels[0]}…`;
  $('.messages').style.visibility = scope === 'session' ? 'hidden' : 'visible';
  announce(''); syncRoute(); open('effort', false); updateURL();
};
$('#unavailable').onchange = () => {
  current().unavailable = $('#unavailable').checked;
  accountModel = null; pending = null; syncRoute(); open('models', false); announce(''); updateURL();
};
function updateURL() {
  const params = new URLSearchParams({ device: $('#app-window').classList.contains('ios') ? 'ios' : 'mac', theme: document.documentElement.dataset.theme ?? 'light', context: scope, palette: $('#palette').value });
  if (current().unavailable) params.set('unavailable','1');
  history.replaceState(null,'',`?${params}`);
}
const params = new URLSearchParams(location.search);
if (['default', 'ocean', 'midnight', 'sand'].includes(params.get('palette'))) { $('#palette').value = params.get('palette'); $('#palette').onchange(); }
if (params.get('device') === 'ios') document.querySelector('[data-device=ios]').click();
if (params.get('theme') === 'dark') $('#theme').click();
if (['group','session','thread'].includes(params.get('context'))) { $('#context').value = params.get('context'); $('#context').onchange(); }
if (params.get('unavailable') === '1') { $('#unavailable').checked = true; $('#unavailable').onchange(); }
syncRoute(); render();
