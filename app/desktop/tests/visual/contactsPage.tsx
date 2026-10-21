import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CommonGroundContactsRow } from '../../src/features/commonGround/CommonGroundContactsRow';
import { normalizeContactProfile, type CloudContactProfile } from '../../src/features/cloud/contactProfileClient';
import type { ContactProfileHost } from '../../src/kordi-app/contacts/contactProfileHost';
import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactClass, ContactRequest, Conversation } from '../../src/kordi-app/types';
import { contactSharedVisualMessages } from './contactSharedFixtures';
import '../../src/index.css';

// Login-free preview of the Contacts page with fictional people.
// Query params: ?theme=light|dark, ?empty=1 (no requests or invites), ?groups=2 (adds a My agents group),
// ?invite=1 (the Common ground row shows a waiting room invitation), ?profile=1 (the richer contact profile),
// ?profile=1&page=photos|files|links (Maya's chat is on hand and that shared page opens in the pane).
// The Common ground page itself has its own preview, commonGroundPage.html.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const withActivity = params.get('empty') !== '1';
const showAgents = params.get('groups') === '2';
const hasInvitation = params.get('invite') === '1';
const withProfile = params.get('profile') === '1';
const sharedPage = withProfile
  ? ({ photos: 'Photos', files: 'Files', links: 'Links' } as Record<string, string>)[params.get('page') ?? '']
  : undefined;
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

const MAYA_AGENT = person('acct_maya_agent', 'Maya’s agent', 'Agent', { classType: 'other-users-agents', entityType: 'agent', detail: '@482731907' });

const PROFILES: Record<string, CloudContactProfile> = Object.fromEntries([
  {
    accountId: 'acct_maya', kordiId: '482731906', displayName: 'Maya Chen', kind: 'person',
    about: 'Memory systems group. Building retrieval for long-running agents.',
    defaultAgent: { agentId: 'agent_maya', accountId: 'acct_maya_agent', displayName: 'Maya’s agent', avatarUrl: null },
    contactSince: '2026-08-12T09:30:00Z',
    shared: { mediaCount: 24, linkCount: 9, documentCount: 3, groups: [{ groupId: 'gs_reading', title: 'Reading group', avatarUrl: null }, { groupId: 'gs_lab', title: 'Lab', avatarUrl: null }] },
    commonGround: { workingOn: ['agent memory', 'retrieval'], canHelp: ['grant writing'], lookingFor: ['eval datasets'] },
  },
  { accountId: 'acct_hana', kordiId: '193847562', kind: 'person', contactSince: '2026-10-20T08:00:00Z', shared: { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] } },
  { accountId: 'acct_ines', kordiId: '650218437', kind: 'person', contactSince: '2026-10-03T08:00:00Z', shared: { mediaCount: 4, linkCount: 0, documentCount: 0, groups: [{ groupId: 'gs_lab', title: 'Lab', avatarUrl: null }] } },
  {
    accountId: 'acct_maya_agent', kordiId: '482731907', kind: 'agent',
    owner: { accountId: 'acct_maya', kordiId: '482731906', displayName: 'Maya Chen', avatarUrl: null },
    shared: { mediaCount: 6, linkCount: 2, documentCount: 5, groups: [] },
  },
  { accountId: 'kordi-support', kind: 'system', about: 'Help with your account and the app.' },
].map((row) => [row.accountId, normalizeContactProfile(row)!]));

function previewProfileHost(contacts: Contact[], select: (contact: Contact) => void): ContactProfileHost {
  return {
    accountIdFor: (contact) => (contact.classType === 'my-agents' ? null : contact.sourceParticipantId ?? null),
    load: async (accountId) => {
      await pause(400);
      const found = PROFILES[accountId];
      if (!found) throw new Error('No profile');
      return found;
    },
    contactForAccount: (accountId) => contacts.find((contact) => contact.sourceParticipantId === accountId) ?? null,
    selectContact: select,
    openAgentChat: () => undefined,
    openGroup: () => undefined,
  };
}

const MAYA_CHAT: Conversation = {
  id: 'session:direct-person:acct_maya:acct_preview', canonicalSessionId: 'session:direct-person:acct_maya:acct_preview',
  name: 'Maya Chen', type: 'person', subtitle: '', unread: 0, collaborationSources: ['Cloud'], trust: '', directness: '',
  participants: ['Me', 'Maya Chen'], messages: contactSharedVisualMessages(),
};

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

function ContactsPreview() {
  const [contacts, setContacts] = useState(() => (withProfile ? [...INITIAL_CONTACTS, MAYA_AGENT] : INITIAL_CONTACTS));
  const [mutedIds, setMutedIds] = useState<Set<string>>(() => new Set());
  const [requests, setRequests] = useState(INITIAL_REQUESTS);
  const [search, setSearch] = useState('');
  const [isRequestsOpen, setIsRequestsOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<ContactClass, boolean>>({ 'other-users': true, 'my-agents': true, 'other-users-agents': true });
  const [activeContactId, setActiveContactId] = useState(sharedPage ? 'cloud:acct_maya' : '');
  const [activeRequestId, setActiveRequestId] = useState('');
  const [overlayMode, setOverlayMode] = useState<'contact' | 'request' | null>(sharedPage ? 'contact' : null);
  const [commonGroundSelected, setCommonGroundSelected] = useState(false);

  useLayoutEffect(() => {
    if (!sharedPage) return undefined;
    const timer = setTimeout(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('.app-contacts-detail-content button');
      [...rows].find((row) => row.textContent?.trim().startsWith(sharedPage))?.click();
    }, 900);
    return () => clearTimeout(timer);
  }, []);

  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (contact: Contact) => !query || `${contact.name} ${contact.subtitle}`.toLowerCase().includes(query);
    const result: Array<{ id: ContactClass; label: string; items: Contact[] }> = [
      { id: 'other-users', label: 'Other users', items: contacts.filter((contact) => !contact.systemContact && contact.classType === 'other-users' && matches(contact)) },
    ];
    const kordi = contacts.filter((contact) => (contact.systemContact || contact.classType === 'other-users-agents') && matches(contact));
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
        contactProfileHost={withProfile ? previewProfileHost(contacts, (contact) => {
          setActiveContactId(contact.id);
          setOverlayMode('contact');
        }) : undefined}
        sharedConversationFor={sharedPage ? (contact) => (contact.sourceParticipantId === 'acct_maya' ? MAYA_CHAT : null) : undefined}
        contactMute={withProfile ? {
          isMuted: (contact) => (contact.systemContact ? null : mutedIds.has(contact.id)),
          setMuted: (contact, muted) => setMutedIds((current) => {
            const next = new Set(current);
            if (muted) next.add(contact.id); else next.delete(contact.id);
            return next;
          }),
        } : undefined}
        onRemoveContact={async (contact) => {
          await pause();
          setContacts((current) => current.filter((item) => item.id !== contact.id));
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ContactsPreview /></StrictMode>);
