// Fictional people and server replies for the login-free Common ground preview.

import type { CgAgentFile, CgPerson, CgProfile, CgProfileTag, CgRelationship, CgRoutedMemory } from '../../src/features/commonGround/types';
import type { ConnectorProviderId, ConnectorState } from '../../src/features/connectors/connectorsModel';

export function initialsAvatar(name: string, theme: 'light' | 'dark') {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const [fill, ink] = theme === 'light' ? ['#e4e6eb', '#5f6672'] : ['#3a3f48', '#c3c8d1'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${fill}"/>`
    + `<text x="40" y="40" dy="0.35em" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="30" font-weight="500" fill="${ink}">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const stranger: CgRelationship = { contact: false, request: null, requestId: null, conversationId: null };

export function commonGroundFixtures(theme: 'light' | 'dark') {
  const workTag = (accountId: string): CgProfileTag => ({ profileId: `cgp_${accountId}_work`, kind: 'work', name: 'Work' });
  const person = (accountId: string, name: string, relationship: CgRelationship = stranger, profile = workTag(accountId)): CgPerson => (
    { accountId, name, avatarUrl: initialsAvatar(name, theme), hasCard: true, relationship, profile }
  );
  // Three profiles: Work with a card, a custom Workshops card, Health without one yet.
  const profiles: CgProfile[] = [
    { profileId: 'cgp_work', kind: 'work', name: 'Work', design: null, icon: null, focus: 'Memory for long-horizon agents', position: 0, hasCard: true, sharing: true, builtAt: '2026-10-19T09:00:00Z', topicCount: 7 },
    { profileId: 'cgp_ws', kind: 'custom', name: 'Workshops', design: 'workshop', icon: null, focus: 'Poster on memory benchmarks', position: 1, hasCard: true, sharing: true, builtAt: '2026-10-18T09:00:00Z', topicCount: 3 },
    { profileId: 'cgp_health', kind: 'health', name: 'Health', design: null, icon: null, focus: 'Running and sleep', position: 2, hasCard: false, sharing: true, builtAt: null, topicCount: 0 },
  ];
  const self = { accountId: 'acct_you', name: 'Alex Rivera', avatarUrl: initialsAvatar('Alex Rivera', theme), handle: 'alexrivera' };
  const documents = [
    { attachmentId: 'att_plan', title: 'Eval plan', updatedAt: '2026-10-18T09:00:00Z', sizeBytes: 2400 },
    { attachmentId: 'att_notes', title: 'Reading notes', updatedAt: '2026-10-12T09:00:00Z', sizeBytes: 5100 },
  ];
  const maya = person('acct_maya', 'Maya Chen', { ...stranger, contact: true, conversationId: 'dm_maya' });
  const hana = person('acct_hana', 'Hana Sato');
  const ines = person('acct_ines', 'Ines Wolf', { ...stranger, request: 'incoming', requestId: 'req_ines' });
  const rafa = person('acct_rafa', 'Rafa Mendes', stranger, { profileId: 'cgp_rafa_health', kind: 'health', name: 'Health' });
  const card = {
    workingOn: ['Agent memory', 'Eval design'],
    interests: ['Retrieval', 'On-device inference'],
    canHelp: ['Benchmark design', 'User studies'],
    lookingFor: ['Privacy review'],
    hidden: ['User studies'],
    revision: 4,
    builtAt: '2026-10-19T09:00:00Z',
    profile: {
      latest: ['Agent memory', 'Eval design', 'Retrieval'],
      earlier: ['Speech recognition'],
      timeline: [
        { period: '2026 Q4', topics: ['Retrieval', 'Privacy review'] },
        { period: '2026 Q3', topics: ['Agent memory', 'Eval design', 'Benchmark design'] },
        { period: '2026 Q1', topics: ['User studies', 'On-device inference'] },
      ],
      topics: {
        'Agent memory': { refs: ['e1', 'e2'], firstSeen: '2026-08-03', lastSeen: '2026-10-12' },
        'Eval design': { refs: ['e3', 'e1'], firstSeen: '2026-09-09', lastSeen: '2026-10-09' },
        Retrieval: { refs: ['e4', 'e5'], firstSeen: '2026-10-15', lastSeen: '2026-10-15' },
        'Benchmark design': { refs: ['e6'], firstSeen: '2026-09-20', lastSeen: '2026-10-02' },
        'User studies': { refs: ['e7'], firstSeen: '2026-02-11', lastSeen: '2026-10-06' },
        'On-device inference': { refs: [], firstSeen: '2026-03-02', lastSeen: '2026-03-02' },
        'Privacy review': { refs: ['e7'], firstSeen: '2026-10-16', lastSeen: '2026-10-16' },
      },
      evidence: {
        e1: { source: 'Notes', title: 'Your notes', date: '2026-10-12', url: null, snippet: 'Drafting the long-horizon memory section with Hana: agents should keep what they learned across sessions, and we compare episodic and semantic stores on the same tasks before the workshop deadline in November.' },
        e2: { source: 'Papers', title: 'Agent memory survey.pdf', date: '2026-10-03', url: null, snippet: 'Section 4 compares episodic and semantic stores.' },
        e3: { source: 'Calendar', title: 'Eval reading group', date: '2026-10-09', url: null, snippet: 'Weekly, with the evaluation group.' },
        e4: { source: 'Calendar', title: 'Retrieval sync with Rafa', date: '2026-10-15', url: null, snippet: 'Agenda: chunking and reranking.' },
        e5: { source: 'GitHub', title: 'rerank-bench #42', date: '2026-10-14', url: 'https://github.com/example/rerank-bench/pull/42', snippet: 'Adds a reranking baseline to the retrieval harness.' },
        e6: { source: 'Memory', title: 'Saved memory', date: '2026-10-02', url: null, snippet: 'Prefers small benchmarks that run in under an hour.' },
        e7: { source: 'Notes', title: 'Your notes', date: '2026-10-06', url: null, snippet: 'Running a 3-month diary study on how people use agents at work.' },
      },
    },
  };
  // The Work card's routed memories, newest first; the schedule memory is listed on every fixed-kind profile.
  const memories: CgRoutedMemory[] = [
    { memoryId: 'mem_1', text: 'Reviewing the retrieval benchmark draft with Hana this week.', category: 'work_context', updatedAt: '2026-10-20T08:00:00Z', profileId: 'cgp_work', everyProfile: false },
    { memoryId: 'mem_2', text: 'Taking the evening course on causal inference until December.', category: 'education_learner_profile', updatedAt: '2026-10-19T18:00:00Z', profileId: 'cgp_work', everyProfile: false },
    { memoryId: 'mem_3', text: 'Free for meetings 10:00 to 16:00 Central European Time on weekdays.', category: 'coordination_context', updatedAt: '2026-10-18T09:00:00Z', profileId: null, everyProfile: true },
    { memoryId: 'mem_4', text: 'Leads the evaluation working group with Maya and Rafa.', category: 'work_context', updatedAt: '2026-10-02T09:00:00Z', profileId: 'cgp_work', everyProfile: false },
  ];
  const owner = { memoriesSinceBuild: 3, card, sharing: true, build: { status: 'idle', errorCode: null }, profile: { profileId: 'cgp_work', kind: 'work', name: 'Work', design: null, icon: null, focus: null } };
  const healthOwner = { card: null, sharing: true, build: { status: 'idle', errorCode: null }, profile: { profileId: 'cgp_health', kind: 'health', name: 'Health', design: null, icon: null, focus: 'Running and sleep' } };
  const room = {
    roomId: 'room_1', code: '4821', name: 'Poster session', openedByYou: true, expiresAt: '2026-10-21T10:00:00Z', open: true,
    kind: 'work', profileId: 'cgp_work', members: [maya, hana, ines, rafa],
  };
  const results = {
    status: 'ready',
    profileId: 'cgp_work',
    people: [
      { person: hana, score: 82, headline: 'Agent memory' },
      { person: maya, score: 67, headline: 'Can help with privacy review' },
      { person: rafa, score: 41, headline: 'Retrieval' },
      { person: ines, score: 18, headline: 'Different area' },
    ],
    topics: [
      { label: 'Agent memory', people: [self, hana, maya] },
      { label: 'Retrieval', people: [self, rafa] },
      { label: 'Eval design', people: [hana, ines] },
    ],
    suggestion: { label: 'Agent memory', people: [self, hana, maya] },
    groups: [{ groupSpaceId: 'gs_eval', conversationId: 'group:gs_eval', name: 'Eval reading group', memberCount: 4, createdBy: maya, joined: true, topic: 'Eval design', members: [maya, hana, ines, rafa] },
      { groupSpaceId: 'gs_memory', conversationId: 'group:gs_memory', name: 'Agent memory notes', memberCount: 2, createdBy: hana, joined: true, topic: null, members: [hana, rafa] },
      { groupSpaceId: 'gs_solo', conversationId: 'group:gs_solo', name: 'Privacy review', memberCount: 1, createdBy: ines, joined: false, topic: 'Privacy review', members: [ines] },
    ],
    invitations: [{ invitationRef: 'inv_1', groupSpaceId: 'gs_ret', name: 'Retrieval', from: rafa, createdAt: '2026-10-20T09:00:00Z' }],
  };
  // As the server sends it: the relationship beside the person, not inside it.
  const { relationship: _hanaRelationship, ...hanaPerson } = hana;
  const match = {
    status: 'ready',
    person: hanaPerson,
    score: 82,
    headline: 'Agent memory',
    shared: [
      { topic: 'Agent memory', theirTopic: 'Long-term memory for agents', why: 'You both study how agents keep context across sessions.' },
      { topic: 'Eval design', theirTopic: 'Memory benchmarks', why: 'Her benchmark needs the evaluation design you are writing.' },
    ],
    youBring: [{ topic: 'Benchmark design', for: 'Memory benchmarks', why: '' }],
    theyBring: [{ topic: 'Privacy review', for: 'Privacy review', why: '' }],
    nextStep: 'Compare your memory evals over coffee.',
    relationship: stranger,
  };
  const connector = (providerId: ConnectorProviderId, connected: boolean): ConnectorState => ({
    providerId,
    status: connected ? 'connected' : 'not_connected',
    connectedAt: connected ? '2026-10-12T09:00:00Z' : null,
    grantedScopeIds: [],
    actEnabled: false,
    agentIds: [],
    lastEventAt: null,
  });
  const connectors = [connector('gmail', false), connector('google_calendar', false), connector('github', true), connector('slack', false)];
  const agentFiles: CgAgentFile[] = ['AGENTS.md', '.claude/CLAUDE.md', '.codex/AGENTS.md', '.codex/instructions/style.md', '.claude/projects/notes/memory/evals.md']
    .map((label) => ({ label, text: 'Fictional preview text.' }));
  const recent = { people: results.people.slice(0, 3).map((entry, index) => ({ ...entry, profileId: 'cgp_work', openedAt: `2026-10-${18 - index}T10:00:00Z` })) };
  const rooms = { rooms: [
    { code: '4821', name: 'Poster session', kind: 'work', profileId: 'cgp_work', open: true, memberCount: 5, joinedAt: '2026-10-20T09:00:00Z', lastActivityAt: '2026-10-20T09:40:00Z', themeCount: 3 },
    { code: '1907', name: 'Reading club', kind: null, profileId: 'cgp_work', open: false, memberCount: 3, joinedAt: '2026-10-14T18:00:00Z', lastActivityAt: '2026-10-14T19:30:00Z', themeCount: 2 },
  ] };
  // Code 5160 previews a meetup that suggests the custom Workshops card.
  const preview = { code: '5160', name: 'Poster session 2026', kind: 'custom', memberCount: 14 };
  // Pair: your code for two minutes from now, and Hana's card once her code is redeemed.
  const pairCode = () => ({ code: 'K4M7-2QXA', expiresAt: new Date(Date.now() + 120_000).toISOString(), profileId: 'cgp_work' });
  const paired = { person: hanaPerson, card, relationship: stranger };
  return { self, documents, owner, memories, healthOwner, profiles, room, rooms, results, match, recent, connectors, agentFiles, preview, pairCode, paired };
}
