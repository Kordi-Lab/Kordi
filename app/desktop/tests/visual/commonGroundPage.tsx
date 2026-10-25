import HelpTour from '../../src/features/onboarding/HelpTour';
import { requestHelpGrounding } from '../../src/features/onboarding/helpNavigation';
import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { createCommonGroundClient } from '../../src/features/commonGround/client';
import { CommonGroundContactsRow } from '../../src/features/commonGround/CommonGroundContactsRow';
import { CommonGroundPage } from '../../src/features/commonGround/CommonGroundPage';
import type { CgHost } from '../../src/features/commonGround/host';
import { localProfileMemory, profileStorageKey } from '../../src/features/commonGround/profiles';
import { CommonGroundStore, type CgScreen } from '../../src/features/commonGround/store';
import { saveSession } from '../../src/features/cloud/session';
import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactClass } from '../../src/kordi-app/types';
import { commonGroundFixtures, initialsAvatar } from './commonGroundFixtures';
import '../../src/index.css';

// Login-free preview of Common ground in the real Contacts page. A fetch stub answers the
// `/v1/cloud/common-ground` routes from fixtures, with three profiles (`commonGroundVersion` 3).
// Query: ?screen=home|build|card|look|lobby|results|match|meet|pair|pair-off, ?theme=light|dark.
// "look" is the card page with the background and icon popover open; "pair" is Home with the
// Pair popover open, and "pair-off" the same with sharing off.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const screen = params.get('screen') ?? 'home';
localStorage.setItem('kordi.themeMode.v1', theme);
const fx = commonGroundFixtures(theme);
if (params.has('emptyCard')) {
  fx.profiles = fx.profiles.map((profile) => ({ ...profile, hasCard: false }));
}

const ROUTES: Record<string, (query: string, body: Record<string, unknown>) => unknown> = {
  'GET profiles': () => ({ profiles: fx.profiles }),
  'GET card': (query) => params.has('emptyCard') ? { ...fx.owner, card: null } : (screen === 'build' || query.includes('cgp_health') ? fx.healthOwner : fx.owner),
  'GET recent': () => fx.recent,
  'GET profiles/cgp_work/memories': () => ({ memories: fx.memories }),
  'GET documents': () => ({ documents: fx.documents }),
  'GET rooms': () => fx.rooms,
  'GET rooms/4821': () => fx.room,
  'GET rooms/5160/preview': () => fx.preview,
  'POST rooms/5160/join': () => ({ ...fx.room, roomId: 'room_5160', code: '5160', name: 'Poster session 2026' }),
  'POST rooms': () => ({ ...fx.room, roomId: 'room_7319', code: '7319', name: 'Agents meetup', members: [] }),
  'POST rooms/4821/results': () => fx.results,
  'POST pairings/code': () => fx.pairCode(),
  'POST pairings/redeem': () => fx.paired,
  'PUT profiles/cgp_work': (_query, body) => (fx.profiles[0] = { ...fx.profiles[0], ...body }),
  // The Meet case shows Hana as a contact, so the Meet tile opens the dialog.
  'GET people/acct_hana/match': () => (screen === 'meet' ? { ...fx.match, relationship: { ...fx.match.relationship, contact: true } } : fx.match),
};

const featureTourActions: string[] = [];
Object.assign(window, { featureTourActions });
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const marker = '/v1/cloud/common-ground/';
  // Move to… and Remove call the account memory routes; the preview accepts them.
  if (url.includes('/v1/cloud/memory/')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes(marker) && init?.method && init.method !== 'GET') featureTourActions.push(init.method);
  const at = url.indexOf(marker);
  if (at < 0) return realFetch(input, init);
  const [path, query = ''] = url.slice(at + marker.length).split('?');
  const reply = ROUTES[`${init?.method ?? 'GET'} ${path}`];
  if (screen === 'pair-off' && path === 'pairings/code') {
    return new Response(JSON.stringify({ errorCode: 'common_ground_sharing_off', message: 'Turn on sharing to meet people.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }
  // Any other code is a room that does not exist.
  if (!reply && /^rooms\/\d{4}\/preview$/.test(path)) {
    return new Response(JSON.stringify({ errorCode: 'common_ground_room_not_found', message: 'Room not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  return reply
    ? new Response(JSON.stringify(reply(query, typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {})), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('', { status: 404 });
};

const STACKS: Record<string, CgScreen[]> = {
  build: [{ name: 'build' }],
  card: [{ name: 'card' }],
  look: [{ name: 'card' }],
  lobby: [{ name: 'lobby', code: '4821' }],
  results: [{ name: 'results', code: '4821' }],
  match: [{ name: 'match', accountId: 'acct_hana' }],
  meet: [{ name: 'match', accountId: 'acct_hana' }],
};

const host: CgHost = {
  self: fx.self,
  profiles: true,
  sources: true,
  memoryAvailable: true,
  memoryRouting: true,
  memoryCards: true,
  openChat: () => undefined,
  acceptRequest: async () => undefined,
  contactsChanged: () => undefined,
  openGroup: () => undefined,
  connectors: {
    client: {
      list: async () => ({ states: fx.connectors, agents: [] }),
      disconnect: async () => undefined,
    },
    openSettings: () => undefined,
  },
  agentFiles: async () => fx.agentFiles,
  device: {
    status: async () => ({ calendar: 'granted', reminders: 'not_determined' }),
    request: async () => ({ calendar: 'granted', reminders: 'granted' }),
    titles: async () => Array.from({ length: 24 }, (_, index) => ({ title: `Event ${index + 1}`, date: '2026-10-01' })),
  },
  openUrl: () => undefined,
};

const CONTACTS: Contact[] = ['Maya Chen', 'Hana Sato', 'Ines Wolf', 'Rafa Mendes'].map((name) => {
  const id = `acct_${name.split(' ')[0].toLowerCase()}`;
  return {
    id: `cloud:${id}`, name, initials: name.split(' ').map((part) => part[0]).join(''), classType: 'other-users', entityType: 'user',
    subtitle: 'Kordi account', collaborationSources: ['Cloud'], status: 'Available', discoverableOn: [], detail: '', owner: name,
    sourceHostId: 'cloud', sourceParticipantId: id, avatarSeed: id, profileImageUrl: initialsAvatar(name, theme),
  };
});

function Preview({ store }: { store: CommonGroundStore }) {
  const [tourOpen, setTourOpen] = useState(params.has('tour'));
  const tourId = params.get('tour') === 'grounding' ? 'grounding' : 'cards';
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
      {tourOpen ? <HelpTour tourId={tourId} progressKey={`feature-tour-test:${tourId}`} settingsAvailable onExit={() => setTourOpen(false)} onPrepare={(step) => {
        if (step.groundingScreen) requestHelpGrounding(fx.self.accountId, step.groundingScreen);
      }} /> : null}
    </div>
  );
}

void saveSession({ token: 'preview', accountId: fx.self.accountId, expiresAt: '2099-01-01T00:00:00Z' }).then(() => {
  // The build screen previews the Health profile, which has no card yet.
  if (screen === 'build') localStorage.setItem(profileStorageKey(fx.self.accountId), 'cgp_health');
  const store = new CommonGroundStore(createCommonGroundClient(), { profiles: true, memory: localProfileMemory(fx.self.accountId) });
  for (const next of STACKS[screen] ?? []) store.open(next);
  createRoot(document.getElementById('root')!).render(<StrictMode><Preview store={store} /></StrictMode>);
  // Opens a popover once its button has rendered.
  const clickWhenReady = (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (button) button.click();
    else requestAnimationFrame(() => clickWhenReady(selector));
  };
  if (screen === 'look') clickWhenReady('.cg-cardpage-glyph.is-look');
  if (screen === 'pair' || screen === 'pair-off') clickWhenReady('[data-cg-pair]');
});
