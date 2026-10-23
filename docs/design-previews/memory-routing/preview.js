// Synthetic memories for the memory routing preview. Nothing here connects to an API.
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const icon = (path) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const ICONS = {
  more: icon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  move: icon('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  remove: icon('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>'),
  brain: icon('<path d="M12 5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 8a3 3 0 0 0 0 6 3 3 0 0 0 3 4 3 3 0 0 0 5 1z"/><path d="M12 5a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 8a3 3 0 0 1 0 6 3 3 0 0 1-3 4 3 3 0 0 1-5 1z"/>'),
  work: icon('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>'),
};

const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Rows as each surface lists them: settings show global memories, a chat its own, the group info page the group's.
const CONTEXTS = [
  { title: 'Memory settings', rows: [
    { text: 'Answer in British English and keep replies short unless I ask for more detail.', source: 'From a correction', date: 'Today', chip: 'Preference' },
    { text: 'Run the full test suite before saying a change is done.', source: 'From a repeated failure', date: '14 Oct', chip: 'Task note' },
  ] },
  { title: 'Chat Memory tab', rows: [
    { text: 'Reviewing the retrieval benchmark draft with Hana this week.', source: 'From a correction', date: 'Yesterday', chip: 'Work' },
  ] },
  { title: 'Group info', rows: [
    { text: 'The group ships the poster on Friday and reviews it on Thursday.', source: 'Added by Priya', date: '18 Oct', chip: 'Schedule' },
  ] },
];

function macRows() {
  return CONTEXTS.map(({ title, rows }) => `
    <p class="m-ctx">${title}</p>
    <div class="m-list">${rows.map((row) => `
      <div class="m-mem">
        <div class="m-mem-text">
          <div class="m-mem-title">${esc(row.text)}</div>
          <div class="m-mem-meta"><span>${row.source} · ${row.date}</span><span class="chip">${row.chip}</span></div>
        </div>
        <div class="m-mem-acts"><button class="qbtn">Edit</button><button class="qbtn">Delete</button></div>
      </div>`).join('')}
    </div>`).join('');
}

function iosRows() {
  return CONTEXTS.map(({ title, rows }) => `
    <p class="i-sec">${title}</p>
    <div class="i-list">${rows.map((row) => `
      <div class="i-row">
        <div class="i-row-text">
          <div class="i-row-title">${esc(row.text)}</div>
          <div class="i-row-sub"><span>${row.source} · ${row.date}</span><span class="i-chip">${row.chip}</span></div>
        </div>
      </div>`).join('')}
    </div>`).join('');
}

// The Work card's routed memories, newest first. The schedule memory is listed on every fixed-kind profile.
const CARD_MEMORIES = [
  { text: 'Reviewing the retrieval benchmark draft with Hana this week.', chip: 'Work', date: 'Yesterday' },
  { text: 'Taking the evening course on causal inference until December.', chip: 'Learning', date: '20 Oct' },
  { text: 'Free for meetings 10:00 to 16:00 Central European Time on weekdays.', chip: 'Schedule', date: '18 Oct', every: true },
  { text: 'Leads the evaluation working group with Maya and Rafa.', chip: 'Work', date: '2 Oct' },
];
const OTHER_PROFILES = ['Health', 'Daily tasks', 'Workshops'];

function macCard() {
  const rows = CARD_MEMORIES.map((row, index) => `
    <div class="mrow">
      <div class="mrow-text">
        <div class="mrow-title">${esc(row.text)}</div>
        <div class="mrow-sub"><span class="chip">${row.chip}</span><span>${row.date}</span>${row.every ? '<span>· Every profile</span>' : ''}</div>
      </div>
      <button class="act" aria-haspopup="menu" aria-expanded="${index === 0}">${ICONS.move}Move to…</button>
      <button class="act">${ICONS.remove}Remove</button>
      ${index === 0 ? `<div class="menu" role="menu">${OTHER_PROFILES.map((name) => `<button role="menuitem">${name}</button>`).join('')}<hr><button role="menuitem">No profile</button></div>` : ''}
    </div>`).join('');
  return `
    <div class="cp-head">
      <span class="cp-glyph">${ICONS.work}</span>
      <div class="cp-title"><h2>Work</h2><div class="cp-meta">7 lines · built 19 Oct · 3 new memories</div></div>
      <button class="mbtn">Rename</button>
      <button class="mbtn is-danger">Delete</button>
      <button class="mbtn is-primary">${ICONS.brain}Rebuild from memory</button>
    </div>
    <h3 class="msec">Working on</h3>
    <div class="panel"><div class="topic">Agent memory</div><div class="topic">Eval design</div></div>
    <h3 class="msec">Looking for</h3>
    <div class="panel"><div class="topic">Privacy review</div></div>
    <h3 class="msec">Memories</h3>
    <div class="panel">${rows}</div>
    <h3 class="msec">Timeline</h3>
    <div class="panel"><div class="stub">2026 Q4 · Retrieval, Privacy review</div></div>`;
}

function iosCard() {
  const rows = CARD_MEMORIES.map((row) => `
    <div class="i-row">
      <div class="i-row-text">
        <div class="i-row-title">${esc(row.text)}</div>
        <div class="i-row-sub"><span class="i-chip">${row.chip}</span><span>${row.date}</span>${row.every ? '<span>· Every profile</span>' : ''}</div>
      </div>
      <button class="i-more" aria-label="More">${ICONS.more}</button>
    </div>`).join('');
  return `
    <div class="i-title">Work</div>
    <div class="i-meta">Built 19 Oct · 3 new memories</div>
    <button class="i-btn">Rebuild from memory</button>
    <p class="i-sec">Memories</p>
    <div class="i-list">${rows}</div>
    <div class="i-sheet" aria-label="Actions for the first memory">
      <div class="i-sheet-title">Move to</div>
      ${OTHER_PROFILES.map((name) => `<button>${name}</button>`).join('')}
      <button>No profile</button>
      <button class="is-danger">Remove</button>
    </div>`;
}

document.getElementById('mac-rows').innerHTML = macRows();
document.getElementById('ios-rows').innerHTML = iosRows();
document.getElementById('mac-card').innerHTML = macCard();
document.getElementById('ios-card').innerHTML = iosCard();
