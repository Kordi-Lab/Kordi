import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CommonGroundContactsRow } from '../../src/features/commonGround/CommonGroundContactsRow';
import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactClass, ContactRequest } from '../../src/kordi-app/types';
import '../../src/index.css';

// Login-free preview of the Contacts page with fictional people.
// Query params: ?theme=light|dark, ?empty=1 (no requests or invites), ?groups=2 (adds a My agents group),
// ?invite=1 (the Common ground row shows a waiting room invitation).
// The Common ground row opens commonGround.html in the detail pane; it talks to the demo API on 127.0.0.1:18190.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const withActivity = params.get('empty') !== '1';
const showAgents = params.get('groups') === '2';
const hasInvitation = params.get('invite') === '1';
localStorage.setItem('kordi.themeMode.v1', theme);

const pause = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const yesterdayAt = (hours: number, minutes: number) => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
};

// Generated avatars come from the cloud API, which the preview does not run, so fixtures carry initials avatars.
function initialsAvatar(name: string) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const [fill, ink] = theme === 'light' ? ['#e4e6eb', '#5f6672'] : ['#3a3f48', '#c3c8d1'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${fill}"/>`
    + `<text x="40" y="40" dy="0.35em" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="30" font-weight="500" fill="${ink}">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function person(id: string, name: string, subtitle: string, overrides: Partial<Contact> = {}): Contact {
  return {
    id: `cloud:${id}`,
    name,
    initials: name.split(' ').map((part) => part[0]).join(''),
    classType: 'other-users',
    entityType: 'user',
    subtitle,
    collaborationSources: ['Cloud'],
    status: 'Available',
    discoverableOn: [],
    detail: '',
    owner: name,
    sourceHostId: 'cloud',
    sourceParticipantId: id,
    avatarSeed: id,
    profileImageUrl: initialsAvatar(name),
    ...overrides,
  };
}

const INITIAL_CONTACTS: Contact[] = [
  person('acct_maya', 'Maya Chen', '@482731906', { presenceStatus: 'online', detail: 'Memory systems group' }),
  person('acct_hana', 'Hana Sato', '@193847562', { presenceStatus: 'offline', presenceLastSeenAt: minutesAgo(9) }),
  person('acct_ines', 'Ines Wolf', '@650218437', { presenceStatus: 'offline', presenceLastSeenAt: yesterdayAt(18, 58) }),
  person('acct_rafa', 'Rafa Mendes', '@771045293', { presenceStatus: 'offline' }),
  person('kordi-support', 'Kordi Support', 'Ask questions or suggest improvements', { locked: true, systemContact: true }),
];

const INITIAL_AGENTS: Contact[] = [
  person('agent_research', 'Research agent', 'On this Mac', { classType: 'my-agents', entityType: 'My agent' }),
];

const INITIAL_REQUESTS: ContactRequest[] = withActivity ? [
  { id: 'req-noor', initials: 'NH', title: 'Noor Haddad wants to connect', avatarName: 'Noor Haddad', profileImageUrl: initialsAvatar('Noor Haddad'), avatarSeed: 'acct_noor', detail: '@305918274', time: minutesAgo(12), direction: 'incoming', status: 'pending' },
  { id: 'req-oskar', initials: 'OB', title: 'Oskar Berg wants to connect', avatarName: 'Oskar Berg', profileImageUrl: initialsAvatar('Oskar Berg'), avatarSeed: 'acct_oskar', detail: '@846203915', time: minutesAgo(60 * 26), direction: 'incoming', status: 'pending' },
  { id: 'req-elio', initials: 'EM', title: 'Request sent to Elio Marin', avatarName: 'Elio Marin', profileImageUrl: initialsAvatar('Elio Marin'), avatarSeed: 'acct_elio', detail: 'acct_elio', targetNodeId: 'acct_elio', time: minutesAgo(90), direction: 'outgoing', status: 'pending' },
] : [];

const LOOKUP: Record<string, { accountId: string; displayName: string }> = {
  '112233445': { accountId: 'acct_lena', displayName: 'Lena Park' },
  '846203915': { accountId: 'acct_oskar', displayName: 'Oskar Berg' },
};

// Preview only: the standalone Common ground page fills the detail pane until the React port lands.
function CommonGroundFrame() {
  const api = params.get('api');
  const src = `./commonGround.html?embedded=1&theme=${theme}${api ? `&api=${encodeURIComponent(api)}` : ''}`;
  return (
    <section aria-label="Common ground" className="flex min-h-0 min-w-0 flex-1">
      <iframe title="Common ground" src={src} className="block h-full w-full border-0" style={{ background: 'transparent', colorScheme: theme }} />
    </section>
  );
}

function ContactsPreview() {
  const [contacts, setContacts] = useState(INITIAL_CONTACTS);
  const [requests, setRequests] = useState(INITIAL_REQUESTS);
  const [search, setSearch] = useState('');
  const [isRequestsOpen, setIsRequestsOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<ContactClass, boolean>>({ 'other-users': true, 'my-agents': true, 'other-users-agents': true });
  const [activeContactId, setActiveContactId] = useState('');
  const [activeRequestId, setActiveRequestId] = useState('');
  const [overlayMode, setOverlayMode] = useState<'contact' | 'request' | null>(null);
  const [commonGroundSelected, setCommonGroundSelected] = useState(true);

  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (contact: Contact) => !query || `${contact.name} ${contact.subtitle}`.toLowerCase().includes(query);
    const result: Array<{ id: ContactClass; label: string; items: Contact[] }> = [
      { id: 'other-users', label: 'Other users', items: contacts.filter((contact) => !contact.systemContact && matches(contact)) },
    ];
    const kordi = contacts.filter((contact) => contact.systemContact && matches(contact));
    if (kordi.length > 0) result.unshift({ id: 'other-users-agents', label: 'Kordi', items: kordi });
    if (showAgents) result.push({ id: 'my-agents', label: 'My agents', items: INITIAL_AGENTS.filter(matches) });
    return result;
  }, [contacts, search]);

  const activeContact = contacts.find((contact) => contact.id === activeContactId) ?? INITIAL_AGENTS.find((contact) => contact.id === activeContactId) ?? contacts[0];

  const resolveRequest = async (request: ContactRequest, accept: boolean) => {
    await pause(900);
    setRequests((current) => current.filter((item) => item.id !== request.id));
    if (accept) {
      const name = request.avatarName ?? 'Kordi user';
      setContacts((current) => [...current, person(request.avatarSeed ?? request.id, name, request.detail)]);
    }
  };

  return (
    <div
      className={`kordi-app theme-${theme} flex h-screen w-screen`}
      style={{ background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}
    >
      <ContactsPage
        filteredGroupedContacts={groups}
        isContactRequestsOpen={isRequestsOpen}
        onToggleRequests={() => setIsRequestsOpen((open) => !open)}
        contactRequests={requests}
        activeContactRequestId={activeRequestId}
        onSelectRequest={(request) => {
          setActiveRequestId(request.id);
          setOverlayMode('request');
          setCommonGroundSelected(false);
        }}
        leadingListItems={(
          <CommonGroundContactsRow
            selected={commonGroundSelected}
            hasInvitation={hasInvitation}
            onSelect={() => {
              setCommonGroundSelected(true);
              setOverlayMode(null);
            }}
          />
        )}
        leadingDetail={commonGroundSelected ? <CommonGroundFrame /> : null}
        onAcceptRequest={(request) => resolveRequest(request, true)}
        onRejectRequest={(request) => resolveRequest(request, false)}
        onLookupContact={async (raw) => {
          await pause();
          const digits = raw.replace(/\D/g, '');
          if (digits.length !== 9) throw new Error('Enter a nine-digit Kordi ID.');
          const match = LOOKUP[digits];
          if (!match) return null;
          return {
            accountId: match.accountId,
            kordiId: digits,
            displayName: match.displayName,
            avatarUrl: null,
            isSelf: false,
            isContact: false,
            isRequestPending: requests.some((request) => request.targetNodeId === match.accountId),
          };
        }}
        onAddContactByNodeId={async (accountId) => {
          await pause();
          const match = Object.values(LOOKUP).find((entry) => entry.accountId === accountId);
          setRequests((current) => [...current, {
            id: `req-${accountId}`,
            initials: '',
            title: `Request sent to ${match?.displayName ?? 'Kordi user'}`,
            avatarName: match?.displayName ?? null,
            profileImageUrl: initialsAvatar(match?.displayName ?? 'Kordi user'),
            avatarSeed: accountId,
            detail: accountId,
            targetNodeId: accountId,
            time: new Date().toISOString(),
            direction: 'outgoing',
            status: 'pending',
          }]);
        }}
        contactSearch={search}
        onContactSearchChange={setSearch}
        expandedContactGroups={expanded}
        onToggleGroup={(groupId) => setExpanded((current) => ({ ...current, [groupId]: !current[groupId] }))}
        activeContactId={activeContactId}
        onSelectContact={(_groupId, contactId) => {
          setActiveContactId(contactId);
          setOverlayMode('contact');
          setCommonGroundSelected(false);
        }}
        contactOverlayMode={overlayMode}
        activeContact={activeContact}
        onCloseOverlay={() => {
          setOverlayMode(null);
          setCommonGroundSelected(false);
        }}
        getStatusBadgeClass={() => ''}
        onMessageContact={() => { setOverlayMode(null); }}
        onRemoveContact={async (contact) => {
          await pause();
          setContacts((current) => current.filter((item) => item.id !== contact.id));
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ContactsPreview /></StrictMode>);
