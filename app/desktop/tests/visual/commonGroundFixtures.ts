// Fictional people and server replies for the login-free Common ground preview.

import type { CgPerson, CgRelationship } from '../../src/features/commonGround/types';

export function initialsAvatar(name: string, theme: 'light' | 'dark') {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const [fill, ink] = theme === 'light' ? ['#e4e6eb', '#5f6672'] : ['#3a3f48', '#c3c8d1'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${fill}"/>`
    + `<text x="40" y="40" dy="0.35em" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="30" font-weight="500" fill="${ink}">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const stranger: CgRelationship = { contact: false, request: null, requestId: null, conversationId: null };

export function commonGroundFixtures(theme: 'light' | 'dark') {
  const person = (accountId: string, name: string, relationship: CgRelationship = stranger): CgPerson => (
    { accountId, name, avatarUrl: initialsAvatar(name, theme), hasCard: true, relationship }
  );
  const self = { accountId: 'acct_you', name: 'Alex Rivera', avatarUrl: initialsAvatar('Alex Rivera', theme) };
  const maya = person('acct_maya', 'Maya Chen', { ...stranger, contact: true, conversationId: 'dm_maya' });
  const hana = person('acct_hana', 'Hana Sato');
  const ines = person('acct_ines', 'Ines Wolf', { ...stranger, request: 'incoming', requestId: 'req_ines' });
  const rafa = person('acct_rafa', 'Rafa Mendes');
  const card = {
    workingOn: ['Agent memory', 'Eval design'],
    interests: ['Retrieval', 'On-device inference'],
    canHelp: ['Benchmark design', 'User studies'],
    lookingFor: ['Privacy review'],
    hidden: ['User studies'],
    revision: 4,
    builtAt: '2026-10-19T09:00:00Z',
  };
  const owner = { card, sharing: true, build: { status: 'idle', errorCode: null } };
  const room = { roomId: 'room_1', code: '4821', name: 'Poster session', openedByYou: true, expiresAt: '2026-10-21T10:00:00Z', members: [maya, hana, ines, rafa] };
  const results = {
    status: 'ready',
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
    groups: [{ groupSpaceId: 'gs_eval', conversationId: 'group:gs_eval', name: 'Eval reading group', memberCount: 4, createdBy: maya, joined: true }],
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
  const recent = { people: results.people.slice(0, 3).map((entry, index) => ({ ...entry, openedAt: `2026-10-${18 - index}T10:00:00Z` })) };
  return { self, owner, room, results, match, recent };
}
