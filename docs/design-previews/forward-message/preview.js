// Synthetic, local-only fixtures. The preview never calls a messaging API.
const destinations = [
  { id: 'product-general', title: 'General', type: 'group', parent: 'Product team', minutes: 2, members: 'Maya Chen Leo Park', time: '2m ago' },
  { id: 'maya', title: 'Maya Chen', type: 'person', parent: '@maya.chen', minutes: 8, time: '8m ago', initials: 'MC' },
  { id: 'onboarding', title: 'Onboarding review', type: 'session', parent: 'Product team', minutes: 24, time: '24m ago' },
  { id: 'research-general', title: 'General', type: 'group', parent: 'Research circle', minutes: 45, members: 'Avery Morgan Leo Park', time: '45m ago' },
  { id: 'leo', title: 'Leo Park', type: 'person', parent: '@leo.park', minutes: 60, time: '1h ago', initials: 'LP' },
  { id: 'papers', title: 'Paper discussion', type: 'session', parent: 'Research circle', minutes: 120, time: '2h ago' },
  { id: 'release', title: 'Release planning', type: 'group', parent: 'Product team', minutes: 180, members: 'Maya Chen', time: '3h ago' },
  { id: 'avery', title: 'Avery Morgan', type: 'person', parent: '@avery.morgan', minutes: 1440, time: 'Yesterday', initials: 'AM' },
];
const $ = (selector) => document.querySelector(selector);
const dialog = $('#forward-dialog');
const search = $('#search');
const list = $('#destinations');
const state = new URLSearchParams(location.search).get('state') || 'default';
let filter = 'all';
let selected = null;
let busy = false;
let timer;
const typeNames = { person: 'Direct message', group: 'Group chat', session: 'Agent chat' };
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function highlighted(value) {
  const query = search.value.trim().toLowerCase();
  const index = query ? value.toLowerCase().indexOf(query) : -1;
  return index < 0 ? escapeHtml(value) : escapeHtml(value.slice(0, index)) + '<mark>' + escapeHtml(value.slice(index, index + query.length)) + '</mark>' + escapeHtml(value.slice(index + query.length));
}
function destinationPath(destination) {
  return destination.type === 'person' ? `${destination.title} · ${destination.parent}` : `${destination.parent} › ${destination.title}`;
}
function render() {
  const query = search.value.trim().toLowerCase();
  const rows = destinations.filter((item) => (filter === 'all' || item.type === filter) && `${item.title} ${item.parent} ${item.members || ''} ${typeNames[item.type]}`.toLowerCase().includes(query)).sort((a, b) => a.minutes - b.minutes);
  $('#clear-search').hidden = !query;
  $('#list-title').textContent = query ? 'Search results' : 'Recent chats';
  $('#list-detail').textContent = query ? `${rows.length} ${rows.length === 1 ? 'result' : 'results'}` : '';
  $('#result-status').textContent = `${rows.length} destinations found.`;
  list.innerHTML = rows.map((item) => `<button class="destination" data-id="${item.id}" aria-pressed="${selected?.id === item.id}" ${busy ? 'disabled' : ''}><span class="avatar ${item.type}">${item.initials || icon(item.type)}</span><span class="identity"><span class="row-title">${highlighted(item.title)}</span><span class="row-context">${item.type === 'person' ? `${typeNames[item.type]} · ${highlighted(item.parent)}` : `<strong>${highlighted(item.parent)}</strong> · ${typeNames[item.type]}`}${query && (item.members || '').toLowerCase().includes(query) && !`${item.title} ${item.parent}`.toLowerCase().includes(query) ? `<br>Member: ${highlighted(item.members)}` : ''}</span></span><span class="row-meta"><span>${item.time}</span><span class="selection-check">${icon('check')}</span></span></button>`).join('');
  if (!rows.length) list.innerHTML = `<div class="empty">${icon('search')}<h4>No matching ${filter === 'all' ? 'destinations' : filter === 'person' ? 'people' : filter === 'session' ? 'agents' : filter + 's'}</h4><p>Try a name, username, or group name.</p><button class="text-button" id="reset-search">Clear search and filters</button></div>`;
  $('#reset-search')?.addEventListener('click', resetSearch);
  $('#selection-summary').innerHTML = selected ? `To <strong>${escapeHtml(destinationPath(selected))}</strong>` : 'Choose a destination to continue.';
  $('#forward').disabled = !selected || busy;
}
function resetSearch() {
  search.value = ''; filter = 'all';
  document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === 'all')));
  render(); search.focus();
}
function closeDialog() { clearTimeout(timer); busy = false; dialog.close(); $('#open').focus(); }
function openDialog() {
  clearTimeout(timer); selected = null; busy = false;
  $('#comment').value = ''; $('#send-error').hidden = true; $('#success').hidden = true;
  $('.dialog-header').hidden = false;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  document.querySelectorAll('.source, .picker, footer').forEach((element) => element.hidden = false);
  $('#forward').innerHTML = `${icon('forward')}<span>Forward</span>`;
  $('#forward').removeAttribute('aria-busy');
  resetSearch(); dialog.showModal(); search.focus();
}
function showSuccess() {
  busy = false;
  document.querySelectorAll('.source, .picker, footer').forEach((element) => element.hidden = true);
  $('#success').hidden = false;
  $('.dialog-header').hidden = true;
  dialog.setAttribute('aria-labelledby', 'success-title');
  $('#done').focus();
}
search.addEventListener('input', render);
$('#clear-search').addEventListener('click', () => { search.value = ''; render(); search.focus(); });
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  render();
}));
list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-id]');
  if (!button || busy) return;
  selected = destinations.find((item) => item.id === button.dataset.id);
  $('#send-error').hidden = true;
  render(); list.querySelector(`[data-id="${selected.id}"]`).focus({ preventScroll: true });
});
// Enter in search never sends a message; selection and forwarding are separate actions.
search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button')?.focus(); }
  if (event.key === 'Enter') event.preventDefault();
});
list.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const rows = [...list.querySelectorAll('button')];
  const index = rows.indexOf(document.activeElement);
  rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
});
$('#forward').addEventListener('click', () => {
  if (!selected || busy) return;
  busy = true; $('#send-error').hidden = true;
  $('#forward').innerHTML = '<span>Forwarding…</span>';
  $('#forward').setAttribute('aria-busy', 'true'); render();
  timer = setTimeout(showSuccess, 700);
});
['#close', '#cancel', '#done'].forEach((id) => $(id).addEventListener('click', closeDialog));
$('#open').addEventListener('click', openDialog);
dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
dialog.addEventListener('click', (event) => { const rect = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeDialog(); });
openDialog();
if (['selected', 'hover', 'focus', 'active', 'error', 'success'].includes(state)) { selected = destinations[2]; render(); }
if (['hover', 'focus', 'active'].includes(state)) list.querySelector('[data-id="onboarding"]').classList.add(`is-${state}`);
if (state === 'error') $('#send-error').hidden = false;
if (state === 'success') showSuccess();
if (state === 'empty') { search.value = 'Nonexistent conversation'; render(); }
if (state === 'loading') { list.setAttribute('aria-busy', 'true'); list.innerHTML = '<span class="sr-only">Loading recent chats</span>' + '<div class="skeleton"></div>'.repeat(4); $('#list-detail').textContent = 'Loading…'; }
