// Synthetic people, cards, requests and the nearby rules the preview applies.

export const ME = { id: 'me', name: 'Alex Kim', initials: 'AK' };

// The wallet, as in the profile cards preview.
export const CARDS = [
  { id: 'work', kind: 'work', name: 'Work', focus: 'Memory for long-horizon agents', topics: ['Agent memory', 'Long-context evaluation', 'Tool-use safety', 'Retrieval', 'Tracing'] },
  { id: 'kaust', kind: 'research', name: 'KAUST', focus: 'Visiting the vision group this spring', topics: ['Video understanding', 'Dataset curation', 'Shared GPU cluster'] },
  { id: 'poster', kind: 'workshop', name: 'Workshops', focus: 'Poster on memory benchmarks', topics: ['Memory benchmarks', 'Poster feedback', 'Reading group'] },
  { id: 'health', kind: 'health', name: 'Health', focus: 'Running and better sleep', topics: ['Half marathon training', 'Sleep tracking'] },
];
export const SHAREABLE = ['work', 'kaust', 'poster', 'health'];

// Distance bands, as the server returns them.
export const BANDS = [[500, 'Under 500 m'], [1000, 'Under 1 km'], [2000, '1–2 km'], [5000, '2–5 km'], [10000, '5–10 km'], [25000, '10–25 km']];
export const RANGES = [[500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km'], [10000, '10 km'], [25000, '25 km']];
export const SCORES = [[0, 'Any'], [50, '50%+'], [70, '70%+'], [85, '85%+']];
export const PER_DAY = [[1, '1 a day'], [3, '3 a day'], [10, '10 a day']];
export const OPEN_TO = ['Coffee chat', 'Collaborating', 'Advice', 'Hiring'];
export const band = (m) => (BANDS.find(([max]) => m <= max) || BANDS[BANDS.length - 1])[1];
export const rangeLabel = (r) => (RANGES.find(([v]) => v === r) || RANGES[2])[1];
export const rangePill = (r) => `Within ${rangeLabel(r)}`;
export const scorePill = (s) => (s ? `${s}%+ match` : 'Any match');
export const perDay = (n) => (PER_DAY.find(([v]) => v === n) || PER_DAY[1])[1];

// People present within 25 km. Tomas sits exactly on 1 km, Leo on 2 km,
// Priya on 70% and Ana on 85%, so the filters show the edges.
export const PEOPLE = [
  { id: 'maya', name: 'Maya Chen', initials: 'MC', m: 380, score: 92, headline: 'Both build memory for agents', profile: { kind: 'work', name: 'Work' }, openTo: ['Collaborating'], meets: ['n1'] },
  { id: 'leo', name: 'Leo Park', initials: 'LP', m: 2000, score: 61, headline: 'Both work on tool-use safety', profile: { kind: 'work', name: 'Work' }, openTo: ['Advice'], meets: ['n1'] },
  { id: 'tomas', name: 'Tomas Berg', initials: 'TB', m: 1000, score: 88, headline: 'Both evaluate long context', profile: { kind: 'research', name: 'Lab' }, openTo: ['Coffee chat'], meets: [] },
  { id: 'priya', name: 'Priya Nair', initials: 'PN', m: 1600, score: 70, headline: 'Both study retrieval for agents', profile: { kind: 'work', name: 'Work' }, openTo: [], meets: [] },
  { id: 'ana', name: 'Ana Ruiz', initials: 'AR', m: 4200, score: 85, headline: 'Both trace agent runs', profile: { kind: 'workshop', name: 'Workshops' }, openTo: ['Hiring'], meets: [] },
  { id: 'noor', name: 'Noor Haddad', initials: 'NH', m: 7800, score: 79, headline: 'Both build evaluation harnesses', profile: { kind: 'work', name: 'Work' }, openTo: [], meets: [] },
  { id: 'sara', name: 'Sara Lind', initials: 'SL', m: 12400, score: 66, headline: 'Both read about agent safety', profile: { kind: 'work', name: 'Work' }, openTo: [], meets: [] },
];
// Present but not matched yet: counted in "Matching N more".
export const MATCHING = [{ m: 900 }, { m: 1800 }];

// The viewer's requests. The tag on a person row uses the short label.
export const NEEDS = [
  { id: 'n1', text: 'Someone founding a startup', label: 'Founding a startup', range: 2000, window: null, paused: false, ended: false },
  { id: 'n2', text: 'Coffee with a Fudan or SJTU alum', label: 'Fudan or SJTU alum', range: 1000, window: { from: '3:00 PM', until: '6:00 PM' }, paused: false, ended: false },
  { id: 'n3', text: 'Demo partner for the poster session', label: 'Demo partner', range: 2000, window: { from: '10:00 AM', until: '12:00 PM' }, paused: false, ended: true },
];
// "3:00 PM" to "6:00 PM" reads "3–6 PM today".
export function windowLabel(w) {
  const short = (t) => t.replace(':00', '');
  const [a, b] = [short(w.from), short(w.until)];
  const same = a.slice(-2) === b.slice(-2);
  return `${same ? a.slice(0, -3) : a}–${b} today`;
}
export function needSub(n) {
  if (n.ended) return 'Ended';
  if (n.paused) return 'Paused';
  return `${n.window ? windowLabel(n.window) : 'No end'} · ${rangeLabel(n.range)}`;
}
export const activeNeed = (n) => !n.ended && !n.paused;

export function meetsOf(p, needs) {
  return needs.filter((n) => activeNeed(n) && p.meets.includes(n.id) && p.m <= n.range);
}
// Search: range and minimum score, then people who meet a request, score, band, name.
export function listPeople(nb, needs) {
  if (nb.empty) return [];
  const bandIx = (m) => BANDS.findIndex(([max]) => m <= max);
  return PEOPLE.filter((p) => p.m <= nb.range && p.score >= nb.min)
    .map((p) => ({ ...p, met: meetsOf(p, needs) }))
    .sort((a, b) => (b.met.length > 0) - (a.met.length > 0) || b.score - a.score || bandIx(a.m) - bandIx(b.m) || a.name.localeCompare(b.name));
}
export const matchingCount = (nb) => (nb.empty ? 0 : MATCHING.filter((x) => x.m <= nb.range).length);
export const personById = (id) => PEOPLE.find((p) => p.id === id) || PEOPLE[0];

// What the person page shows for Maya: checks per request, then the match.
export const CHECKS = {
  maya: [
    { need: 'n1', checks: [{ text: 'Founding a startup', met: true, evidence: 'Working on · Founding Loom Labs' }] },
    { need: 'n2', checks: [{ text: 'Fudan or SJTU alum', met: true, evidence: 'Profile · Fudan University' }, { text: 'Wants a coffee chat', met: false, evidence: 'Not shared' }] },
  ],
  leo: [{ need: 'n1', checks: [{ text: 'Founding a startup', met: true, evidence: 'Working on · Seed-stage robotics' }] }],
};
export const MATCH = {
  shared: [
    { topic: 'Agent memory', why: 'You both build memory stores', icon: 'brain', tone: 'pink' },
    { topic: 'Retrieval', why: 'You both rerank results first', icon: 'sparkle', tone: 'cyan' },
  ],
  youBring: [{ topic: 'Long-context evaluation', why: 'For her memory benchmark', icon: 'seal', tone: 'accent' }],
  theyBring: [{ topic: 'Fundraising', why: 'For your spin-out questions', icon: 'coin', tone: 'amber' }],
};

// Home, as it ships: rooms and recent matches.
export const ROOMS = [
  { name: 'Poster session 2026', sub: '14 people · 3 topics' },
  { name: 'Lab lunch', sub: '5 people · 2 topics · Closed' },
];
export const RECENT = [
  { name: 'Jonas Weber', initials: 'JW', line: 'Both care about eval harnesses', score: 81 },
  { name: 'Mina Sato', initials: 'MS', line: 'Both run reading groups', score: 74 },
];
