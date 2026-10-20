import { StrictMode, useLayoutEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

import { createCommonGroundClient } from '../../src/features/commonGround/client';
import { CommonGroundContactsRow } from '../../src/features/commonGround/CommonGroundContactsRow';
import { CommonGroundPage } from '../../src/features/commonGround/CommonGroundPage';
import type { CgHost } from '../../src/features/commonGround/host';
import { CommonGroundStore, type CgScreen } from '../../src/features/commonGround/store';
import { saveSession } from '../../src/features/cloud/session';
import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactClass } from '../../src/kordi-app/types';
import { commonGroundFixtures, initialsAvatar } from './commonGroundFixtures';
import '../../src/index.css';

// Login-free preview of Common ground in the real Contacts page. A fetch stub answers the
// `/v1/cloud/common-ground` routes from fixtures. Query: ?screen=home|build|card|lobby|results|match,
// ?theme=light|dark.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const screen = params.get('screen') ?? 'home';
localStorage.setItem('kordi.themeMode.v1', theme);
const fx = commonGroundFixtures(theme);

const ROUTES: Record<string, () => unknown> = {
  'GET card': () => (screen === 'build' ? { ...fx.owner, card: null } : fx.owner),
  'GET recent': () => fx.recent,
  'GET rooms': () => fx.rooms,
  'GET rooms/4821': () => fx.room,
  'POST rooms/4821/results': () => fx.results,
  'GET people/acct_hana/match': () => fx.match,
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const marker = '/v1/cloud/common-ground/';
  const at = url.indexOf(marker);
  if (at < 0) return realFetch(input, init);
  const reply = ROUTES[`${init?.method ?? 'GET'} ${url.slice(at + marker.length)}`];
  return reply
    ? new Response(JSON.stringify(reply()), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('', { status: 404 });
};

const STACKS: Record<string, CgScreen[]> = {
  card: [{ name: 'card' }],
  lobby: [{ name: 'lobby', code: '4821' }],
  results: [{ name: 'results', code: '4821' }],
  match: [{ name: 'match', accountId: 'acct_hana' }],
};

const host: CgHost = {
  self: fx.self,
  memoryAvailable: true,
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

void saveSession({ token: 'preview', accountId: fx.self.accountId, expiresAt: '2099-01-01T00:00:00Z' }).then(() => {
  const store = new CommonGroundStore(createCommonGroundClient());
  for (const next of STACKS[screen] ?? []) store.open(next);
  createRoot(document.getElementById('root')!).render(<StrictMode><Preview store={store} /></StrictMode>);
});
