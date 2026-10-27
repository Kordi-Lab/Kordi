import { StrictMode, useLayoutEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

import { createCommonGroundClient } from '../../src/features/commonGround/client';
import { CommonGroundContactsRow } from '../../src/features/commonGround/CommonGroundContactsRow';
import { CommonGroundPage } from '../../src/features/commonGround/CommonGroundPage';
import type { CgHost } from '../../src/features/commonGround/host';
import { localProfileMemory } from '../../src/features/commonGround/profiles';
import { CommonGroundStore, type CgScreen } from '../../src/features/commonGround/store';
import { saveSession } from '../../src/features/cloud/session';
import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactClass } from '../../src/kordi-app/types';
import { commonGroundFixtures, generatedPersonAvatar } from './commonGroundFixtures';
import '../../src/index.css';

// Login-free preview of Grounding › Nearby in the real Contacts page, for comparing with the
// design preview. Not part of the visual spec. A fetch stub answers the Grounding routes from
// fixtures, with Nearby on and the location the iPhone sent three minutes ago.
// Query: ?screen=home|home-off|on|range|score|menu|paused|no-phone|off|consent|request|request-edit|person, ?theme=light|dark.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const screen = params.get('screen') ?? 'home';
localStorage.setItem('kordi.themeMode.v1', theme);
const fx = commonGroundFixtures(theme);
const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const hour = (offset: number) => { const date = new Date(now); date.setMinutes(0, 0, 0); date.setHours(date.getHours() + offset); return date.toISOString(); };

const off = screen === 'off' || screen === 'consent' || screen === 'home-off';
let settings: Record<string, unknown> = {
  enabled: !off,
  participating: !off && screen !== 'paused',
  pausedUntil: screen === 'paused' ? hour(2) : null,
  consentedAt: '2026-10-26T09:00:00Z',
  profileId: 'cgp_work',
  openTo: ['Coffee chat'],
  range: 2000,
  minScore: 0,
  alerts: { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 },
  location: screen === 'no-phone' || off || screen === 'paused' ? null : { capturedAt: at(-3), freshUntil: at(27), fresh: true },
  freshSeconds: 1800,
};
const stranger = { contact: false, request: null, requestId: null, conversationId: null };
const nearbyPerson = (accountId: string, name: string, kind: string, profileName: string) => (
  { accountId, name, avatarUrl: generatedPersonAvatar(accountId), profile: { profileId: `cgp_${accountId}`, kind, name: profileName } }
);
const founding = { needId: 'cgn_1', text: 'Someone founding a startup' };
const entry = (person: ReturnType<typeof nearbyPerson>, maxMeters: number, score: number, headline: string, requests: unknown[] = []) => ({
  person, relationship: stranger, distance: { minMeters: 0, maxMeters }, openTo: [], status: 'ready', score, headline, requests,
});
const maya = nearbyPerson('acct_mchen', 'Maya Chen', 'work', 'Work');
const people = {
  people: [
    entry(maya, 500, 92, 'Both build memory for agents', [founding]),
    entry(nearbyPerson('acct_leo', 'Leo Park', 'work', 'Work'), 2000, 61, 'Both work on tool-use safety', [founding]),
    entry(nearbyPerson('acct_tomas', 'Tomas Berg', 'custom', 'Lab'), 1000, 88, 'Both evaluate long context'),
    entry(nearbyPerson('acct_priya', 'Priya Nair', 'work', 'Work'), 2000, 70, 'Both study retrieval for agents'),
  ],
  matching: 2,
  location: settings.location,
};
const need = (needId: string, text: string, range: number, startsAt: string | null, endsAt: string | null, status = 'active') => (
  { needId, text, range, startsAt, endsAt, paused: false, status, revision: 1, createdAt: at(-60), updatedAt: at(-60) }
);
const needs = [
  need('cgn_1', 'Someone founding a startup', 2000, null, null),
  need('cgn_2', 'Coffee with a Fudan or SJTU alum', 1000, hour(1), hour(4)),
  need('cgn_3', 'Demo partner for the poster session', 2000, at(-300), at(-180), 'ended'),
];
const mayaView = {
  ...entry(maya, 500, 92, 'Both build memory for agents'),
  profileId: 'cgp_work',
  card: { workingOn: ['Founding Loom Labs', 'Agent memory'], interests: ['Retrieval'], canHelp: [], lookingFor: [] },
  requests: [
    { needId: 'cgn_1', text: 'Someone founding a startup', met: true, checks: [{ condition: 0, label: 'Founding a startup', verdict: 'met', kind: 'work', evidence: 'Founding Loom Labs' }] },
    { needId: 'cgn_2', text: 'Coffee with a Fudan or SJTU alum', met: false, checks: [
      { condition: 0, label: 'Fudan or SJTU alum', verdict: 'met', kind: 'affiliation', evidence: 'Fudan University' },
      { condition: 1, label: 'Wants a coffee chat', verdict: 'unknown', kind: 'willingness', evidence: null },
    ] },
  ],
  shared: [
    { topic: 'Agent memory', theirTopic: 'Agent memory', why: 'You both build memory stores' },
    { topic: 'Retrieval', theirTopic: 'Retrieval', why: 'You both rerank results first' },
  ],
  youBring: [{ topic: 'Long-context evaluation', for: 'Memory benchmark', why: '' }],
  theyBring: [{ topic: 'Fundraising', for: 'Spin-out questions', why: '' }],
};

const ROUTES: Record<string, (body: Record<string, unknown>) => unknown> = {
  'GET profiles': () => ({ profiles: fx.profiles }),
  'GET card': () => fx.owner,
  'GET recent': () => fx.recent,
  'GET rooms': () => fx.rooms,
  'GET nearby': () => settings,
  'PUT nearby': (body) => (settings = { ...settings, ...body, alerts: { ...(settings.alerts as object), ...(body.alerts as object | undefined) } }),
  'GET nearby/people': () => people,
  'GET nearby/needs': () => ({ needs }),
  'GET nearby/people/acct_mchen': () => mayaView,
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const marker = '/v1/cloud/common-ground/';
  const index = url.indexOf(marker);
  if (index < 0) return realFetch(input, init);
  const path = url.slice(index + marker.length).split('?')[0];
  const reply = ROUTES[`${init?.method ?? 'GET'} ${path}`];
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  return reply
    ? new Response(JSON.stringify(reply(body)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('', { status: 404 });
};

const STACKS: Record<string, CgScreen[]> = {
  person: [{ name: 'nearby' }, { name: 'nearbyPerson', accountId: 'acct_mchen' }],
};

const host: CgHost = {
  self: fx.self,
  profiles: true,
  sources: true,
  nearby: true,
  memoryAvailable: true,
  openChat: () => undefined,
  acceptRequest: async () => undefined,
  contactsChanged: () => undefined,
  openGroup: () => undefined,
  connectors: null,
  agentFiles: null,
  device: null,
  openUrl: () => undefined,
};

const CONTACTS: Contact[] = ['Hana Sato', 'Ines Wolf', 'Rafa Mendes'].map((name) => {
  const id = `acct_${name.split(' ')[0].toLowerCase()}`;
  return {
    id: `cloud:${id}`, name, initials: name.split(' ').map((part) => part[0]).join(''), classType: 'other-users', entityType: 'user',
    subtitle: 'Kordi account', collaborationSources: ['Cloud'], status: 'Available', discoverableOn: [], detail: '', owner: name,
    sourceHostId: 'cloud', sourceParticipantId: id, avatarSeed: id, profileImageUrl: generatedPersonAvatar(id),
  };
});

function Preview({ store }: { store: CommonGroundStore }) {
  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);
  const groups = useMemo(() => [{ id: 'other-users' as ContactClass, label: 'Other users', items: CONTACTS }], []);
  return (
    <div className={`kordi-app theme-${theme} flex h-screen w-screen`} style={{ background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}>
      <ContactsPage
        filteredGroupedContacts={groups}
        isContactRequestsOpen={false}
        onToggleRequests={() => undefined}
        contactRequests={[]}
        activeContactRequestId=""
        contactSearch=""
        onContactSearchChange={() => undefined}
        expandedContactGroups={{ 'other-users': true, 'my-agents': true, 'other-users-agents': true }}
        onToggleGroup={() => undefined}
        activeContactId=""
        onSelectContact={() => undefined}
        contactOverlayMode={null}
        activeContact={CONTACTS[0]}
        onCloseOverlay={() => undefined}
        getStatusBadgeClass={() => ''}
        leadingListItems={<CommonGroundContactsRow selected onSelect={() => undefined} />}
        leadingDetail={<CommonGroundPage store={store} host={host} />}
      />
    </div>
  );
}

/** Runs `act` on an element once it has rendered, then `then` a moment later. */
function when(find: () => HTMLElement | null | undefined, act: (element: HTMLElement) => void, then?: () => void) {
  const element = find();
  if (!element) { requestAnimationFrame(() => when(find, act, then)); return; }
  act(element);
  if (then) setTimeout(then, 80);
}
const click = (element: HTMLElement) => element.click();
const button = (text: string) => () => [...document.querySelectorAll<HTMLElement>('button')].find((item) => item.textContent?.trim().startsWith(text));
const query = (selector: string) => () => document.querySelector<HTMLElement>(selector);
function typeInto(element: HTMLElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

void saveSession({ token: 'preview', accountId: fx.self.accountId, expiresAt: '2099-01-01T00:00:00Z' }).then(() => {
  const store = new CommonGroundStore(createCommonGroundClient(), { profiles: true, memory: localProfileMemory(fx.self.accountId) });
  const stack = STACKS[screen] ?? (screen === 'home' || screen === 'home-off' ? [] : [{ name: 'nearby' } as CgScreen]);
  for (const next of stack) store.open(next);
  createRoot(document.getElementById('root')!).render(<StrictMode><Preview store={store} /></StrictMode>);
  if (screen === 'range' || screen === 'score') when(query(`[data-cg-nb-menu="${screen}"]`), click);
  if (screen === 'menu') when(query('[data-cg-nb-menu="more"]'), click);
  if (screen === 'consent') when(button('Turn on'), click);
  if (screen === 'request') {
    when(button('Add'), click, () => when(query('textarea'), (area) => typeInto(area, 'Coffee with a Fudan or SJTU alum'), () => {
      when(button('1 km'), click, () => when(query('[aria-label="Time window"]'), click));
    }));
  }
  if (screen === 'request-edit') when(button('Coffee with a Fudan or SJTU alum'), click);
});
