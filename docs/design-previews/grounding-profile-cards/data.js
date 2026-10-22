// Synthetic people, cards, rooms and references.
import { $, esc } from './core.js';

// ---------- synthetic data ----------
export const KINDS = {
  work: { label: 'Work', fixed: true },
  health: { label: 'Health', fixed: true },
  daily: { label: 'Daily tasks', fixed: true },
  workshop: { label: 'Workshop' },
  research: { label: 'Research group', placeholder: 'Group name' },
  custom: { label: 'Custom', placeholder: 'Name' },
};
export const DESIGNS = ['work', 'health', 'daily', 'workshop', 'research', 'custom'];
export const MAX_CARDS = 5;
export const BUILT = {
  work: ['Agent memory', 'Long-context evaluation', 'Tool-use safety', 'Retrieval', 'Tracing'],
  health: ['Half marathon training', 'Sleep tracking', 'Plant-based cooking'],
  daily: ['Bike repair', 'Grocery planning', 'Moving apartments', 'Language exchange'],
  workshop: ['Memory benchmarks', 'Poster feedback', 'Reading group'],
  research: ['Video understanding', 'Dataset curation', 'Shared GPU cluster', 'Arabic speech'],
  custom: ['Board games', 'Weekend hikes', 'Film club'],
};
export const SOURCES = { Memory: 'memory', Gmail: 'mail', Calendar: 'calendar', Papers: 'paper', Health: 'heart', Notes: 'note' };
export const SEED = () => [
  { id: 'work', kind: 'work', name: 'Work', focus: 'Memory for long-horizon agents', topics: BUILT.work.slice(), hidden: [], sources: ['Memory', 'Papers', 'Calendar'] },
  { id: 'kaust', kind: 'research', name: 'KAUST', focus: 'Visiting the vision group this spring', topics: BUILT.research.slice(), hidden: [], sources: ['Memory', 'Gmail'] },
  { id: 'poster', kind: 'workshop', name: 'Workshops', focus: 'Poster on memory benchmarks', topics: BUILT.workshop.slice(), hidden: [], sources: ['Calendar', 'Papers'] },
  { id: 'health', kind: 'health', name: 'Health', focus: 'Running and better sleep', topics: BUILT.health.slice(), hidden: [], sources: ['Health', 'Notes'] },
];
export const ROOMS = () => [
  { id: 'poster26', code: '4821', name: 'Poster session 2026', kind: 'workshop', people: 14, open: true, sharing: null, listed: false },
  { id: 'lunch', code: '3907', name: 'Lab lunch', kind: 'work', people: 5, open: false, sharing: 'work' },
  { id: 'run', code: '5160', name: 'Running club', kind: 'health', people: 8, open: true, sharing: 'health' },
];
export const ME = { name: 'Maya Chen', initials: 'MC' };
export const PEOPLE = [
  { name: 'Tomas Ruiz', initials: 'TR', line: 'Privacy engineering group' },
  { name: 'Priya Nair', initials: 'PN', line: 'HCI lab' },
];
export const NEW_CODE = '7319';

export const RECENT = [
  { p: PEOPLE[0], card: 'work', common: 4 },
  { p: PEOPLE[1], card: 'poster', common: 3 },
];
// References as the app shows them: source, date, title, snippet (latest first).
export const REFS = {
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
export const REBUILD = {
  work: { line: 'Evaluation harnesses', ref: ['Memory', 'Today', 'Saved memory', 'Drafted eval harness notes with Tomas.'], change: ['Memory', 'Today', 'Saved memory', 'Shared the memory draft with Priya.'] },
};
export const CARD_SECTIONS = ['Working on', 'Interests', 'Can help with', 'Looking for'];
export const TOPIC_TONES = ['pink', 'cyan', 'amber', 'accent', 'violet'];
export function topicTone(t) { let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TOPIC_TONES[h % TOPIC_TONES.length]; }
export function sectionOf(c, t) { if (c.sec && c.sec[t]) return c.sec[t]; const i = c.topics.indexOf(t); return CARD_SECTIONS[i < 2 ? 0 : Math.min(i - 1, 3)]; }
export const ctag = (t, muted) => `<span class="ctag tone-${topicTone(t)}${muted ? ' muted' : ''}"><i></i>${esc(t)}</span>`;
export const SOURCE_READ = { Memory: '2 min ago', Papers: '1 h ago', Calendar: '10 min ago', Gmail: '25 min ago', Health: '1 h ago', Notes: 'Yesterday' };
export const SOURCE_TINT = { Memory: '#847ac4', Papers: '#e8590c', Calendar: '#e5484d', Gmail: '#2563eb', Health: '#f83e9c', Notes: '#d9a00b' };
