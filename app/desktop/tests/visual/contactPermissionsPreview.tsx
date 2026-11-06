import './previewChatTheme';
import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { normalizeContactProfile, type CloudContactPermissionFlags, type CloudContactProfile } from '../../src/features/cloud/contactProfileClient';
import type { ContactProfileHost } from '../../src/kordi-app/contacts/contactProfileHost';
import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactClass } from '../../src/kordi-app/types';

// Login-free preview of the contact profile with the per-person Permissions switches, fictional people only.
// Maya's "Use my agent" starts off. Switches flip locally; nothing leaves the page.
// Query params: ?theme=light|dark, ?fail=1 (every save fails, so a switch flips back and shows the error).
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const failSaves = params.get('fail') === '1';
localStorage.setItem('kordi.themeMode.v1', theme);

const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

function initialsAvatar(name: string) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const [fill, ink] = theme === 'light' ? ['#e4e6eb', '#5f6672'] : ['#3a3f48', '#c3c8d1'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${fill}"/>`
    + `<text x="40" y="40" dy="0.35em" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="30" font-weight="500" fill="${ink}">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function person(id: string, name: string, handle: string, overrides: Partial<Contact> = {}): Contact {
  return {
    id: `cloud:${id}`,
    name,
    initials: name.split(' ').map((part) => part[0]).join(''),
    classType: 'other-users',
    entityType: 'user',
    subtitle: handle,
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

const CONTACTS: Contact[] = [
  person('acct_maya', 'Maya Chen', '@482731906', { presenceStatus: 'online' }),
  person('acct_hana', 'Hana Sato', '@193847562', { presenceStatus: 'offline' }),
];

const PROFILES: Record<string, CloudContactProfile> = Object.fromEntries([
  {
    accountId: 'acct_maya', kordiId: '482731906', displayName: 'Maya Chen', kind: 'person',
    about: 'Memory systems group. Building retrieval for long-running agents.',
    defaultAgent: { agentId: 'agent_maya', accountId: null, displayName: 'Maya’s agent', avatarUrl: null },
    contactSince: '2026-08-12T09:30:00Z',
    shared: { mediaCount: 4, linkCount: 2, documentCount: 1, groups: [] },
    commonGround: { workingOn: ['agent memory'], canHelp: ['grant writing'], lookingFor: [] },
    permissions: { agentAccess: false, cardAccess: true },
  },
  // Hana's profile predates the permissions field, so the section loads it from the permissions route.
  { accountId: 'acct_hana', kordiId: '193847562', displayName: 'Hana Sato', kind: 'person', contactSince: '2026-10-20T08:00:00Z', shared: { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] } },
].map((row) => [row.accountId, normalizeContactProfile(row)!]));

const stored: Record<string, CloudContactPermissionFlags> = {
  acct_maya: { agentAccess: false, cardAccess: true },
  acct_hana: { agentAccess: true, cardAccess: true },
};

function previewHost(): ContactProfileHost {
  return {
    accountIdFor: (contact) => contact.sourceParticipantId ?? null,
    load: async (accountId) => {
      await pause();
      const found = PROFILES[accountId];
      if (!found) throw new Error('No profile');
      // Saved flips show again when the profile reopens.
      return found.permissions ? { ...found, permissions: stored[accountId] } : found;
    },
    permissions: {
      load: async (accountId) => {
        await pause();
        return stored[accountId] ?? { agentAccess: true, cardAccess: true };
      },
      save: async (accountId, patch) => {
        await pause(failSaves ? 600 : 200);
        if (failSaves) throw new Error('Could not save permissions.');
        stored[accountId] = { ...(stored[accountId] ?? { agentAccess: true, cardAccess: true }), ...patch };
        return stored[accountId];
      },
    },
  };
}

function ContactPermissionsPreview() {
  const [activeContactId, setActiveContactId] = useState('cloud:acct_maya');
  const [expanded, setExpanded] = useState<Record<ContactClass, boolean>>({ 'other-users': true, 'my-agents': true, 'other-users-agents': true });
  const host = useMemo(() => previewHost(), []);

  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);

  const activeContact = CONTACTS.find((contact) => contact.id === activeContactId) ?? CONTACTS[0];

  return (
    <div className={`kordi-app theme-${theme} flex h-screen w-screen`} style={{ background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}>
      <ContactsPage
        filteredGroupedContacts={[{ id: 'other-users', label: 'Other users', items: CONTACTS }]}
        isContactRequestsOpen={false}
        onToggleRequests={() => undefined}
        contactRequests={[]}
        activeContactRequestId=""
        contactSearch=""
        onContactSearchChange={() => undefined}
        expandedContactGroups={expanded}
        onToggleGroup={(groupId) => setExpanded((current) => ({ ...current, [groupId]: !current[groupId] }))}
        activeContactId={activeContactId}
        onSelectContact={(_groupId, contactId) => setActiveContactId(contactId)}
        contactOverlayMode="contact"
        activeContact={activeContact}
        onCloseOverlay={() => undefined}
        getStatusBadgeClass={() => ''}
        onMessageContact={() => undefined}
        contactProfileHost={host}
        contactMute={{ isMuted: () => false, setMuted: () => undefined }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ContactPermissionsPreview /></StrictMode>);
