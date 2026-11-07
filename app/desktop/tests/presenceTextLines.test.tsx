import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import type { CloudPresenceContactsResponse } from '../src/features/cloud/presence';
import { __setSessionBackendForTests, type StoredSession } from '../src/features/cloud/session';
import { __resetCloudPresenceStoresForTests } from '../src/features/cloud/useCloudPresence';
import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';
import { contact, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

// Presence as a text line where avatar dots used to be: accent names on Group Info tiles,
// Contacts-style presence lines in Add people and in the Chat Info participant list.

const MINUTE = 60_000;
const account = { accountId: 'acct_owner', displayName: 'Owner' } as CloudAccount;
const session: StoredSession = { token: 'synthetic-token', accountId: account.accountId, expiresAt: '2099-01-01T00:00:00Z' };

function groupSpace() {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group:presence',
    canonicalSessionId: 'session:group:presence',
    name: 'Launch crew',
    metadata: { adminIdentityIds: ['human:me'], groupSpaceId: 'session:group:presence', customName: 'Launch crew' },
    participants: ['Me', 'Maya Chen', 'Ethan Park'],
    canonicalParticipants: [
      { id: 'human:me', humanId: 'acct_owner', name: 'Me', kind: 'human', role: 'self', source: 'cloud', avatarKey: 'me', presenceStatus: 'online' },
      { id: 'human:maya', humanId: 'acct_maya', name: 'Maya Chen', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'maya' },
      { id: 'human:ethan', humanId: 'acct_ethan', name: 'Ethan Park', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'ethan' },
    ],
  })]);
  return space;
}

function person(key: string, name: string, handle: string, presenceStatus: string | null, presenceLastSeenAt: string | null) {
  return contact({
    id: `cloud:acct_${key}`,
    name,
    sourceParticipantId: `acct_${key}`,
    sourceHumanId: `acct_${key}`,
    subtitle: handle,
    detail: handle,
    contactStatus: 'accepted',
    presenceStatus,
    presenceLastSeenAt,
  });
}

const groupContacts = [
  person('maya', 'Maya Chen', '@maya', 'online', null),
  person('ethan', 'Ethan Park', '@ethan', 'offline', new Date(Date.now() - 9 * MINUTE).toISOString()),
  person('hana', 'Hana Mori', '@hanamori', 'online', null),
  person('jonah', 'Jonah Weiss', '@jonah', 'offline', new Date(Date.now() - 25 * MINUTE).toISOString()),
  person('elena', 'Elena Rossi', '@elena', null, null),
];

function groupDialog() {
  return createElement(GroupDetailsDialog, {
    isOpen: true,
    space: groupSpace(),
    contacts: groupContacts,
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  });
}

test('Group Info tiles put online people in the accent with an accessible description, never self', () => {
  const markup = renderToStaticMarkup(groupDialog());
  const tile = (name: string) => markup.match(new RegExp(`<button[^>]*aria-label="${name}, [^"]*"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';
  const tileTag = (name: string) => tile(name).match(/^<button[^>]*>/)?.[0] ?? '';
  const nameTag = (name: string) => tile(name).match(new RegExp(`<span[^>]*title="${name}">`))?.[0] ?? '';

  assert.match(tileTag('Maya Chen'), /aria-description="online"/);
  assert.match(nameTag('Maya Chen'), /app-contacts-presence-online/);
  assert.doesNotMatch(tileTag('Ethan Park'), /aria-description=/);
  assert.doesNotMatch(nameTag('Ethan Park'), /app-contacts-presence-online/);
  // Self is online in the fixture but is never marked.
  assert.doesNotMatch(tileTag('Me'), /aria-description=/);
  assert.doesNotMatch(nameTag('Me'), /app-contacts-presence-online/);
  // No extra line under the name.
  assert.doesNotMatch(markup, />online</);
});

test('Add people rows show the Contacts presence line in place of the handle', async () => {
  await withJsdomRoot(async (mount) => {
    // React's legacy input-event fallback probes these IE methods in jsdom.
    Object.assign(window.HTMLElement.prototype, { attachEvent: () => {}, detachEvent: () => {} });
    const host = await mount(groupDialog());
    const addTile = host.querySelector<HTMLButtonElement>('[data-group-member-grid] button[aria-label="Add people"]');
    assert.ok(addTile);
    await act(async () => { addTile.click(); });
    await waitForReactCondition(() => Boolean(host.querySelector('[aria-label="Contacts available to add"]')), 'Add people opens');
    const rows = [...host.querySelectorAll('[aria-label="Contacts available to add"] button')];
    const row = (name: string) => rows.find((item) => item.textContent?.startsWith(name));

    const hana = row('Hana Mori')?.querySelector('.app-contacts-presence-online');
    assert.equal(hana?.textContent, 'online');
    assert.match(row('Jonah Weiss')?.textContent ?? '', /last seen 25 minutes ago/);
    assert.doesNotMatch(row('Jonah Weiss')?.textContent ?? '', /@jonah/);
    // Unknown presence keeps the handle.
    assert.match(row('Elena Rossi')?.textContent ?? '', /@elena/);
  });
});

function setUpPresence(t: TestContext, accounts: CloudPresenceContactsResponse['accounts']) {
  __resetCloudPresenceStoresForTests();
  __setSessionBackendForTests({ load: async () => session, save: async () => undefined, clear: async () => undefined });
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: undefined });
  t.mock.method(CloudAuthClient.prototype, 'listContactPresence', async (): Promise<CloudPresenceContactsResponse> => ({ accounts }));
  // The Info tab also loads scheduled tasks; answer with none.
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  t.after(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: originalWebSocket });
    __resetCloudPresenceStoresForTests();
    __setSessionBackendForTests(null);
  });
}

function infoPanel(overrides: Record<string, unknown>) {
  return createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'info',
    activeConv: {
      id: 'session:group:presence',
      canonicalSessionId: 'session:group:presence',
      name: 'Launch crew',
      type: 'group',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Owned',
      directness: 'Group chat',
      participants: ['Me', 'Maya Chen', 'Ethan Park'],
      messages: [],
      ...overrides,
    } as never,
    activeConvHasSubtitle: false,
    activeConversationUsesCollaboration: true,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
    cloudAccount: account,
  });
}

test('Chat Info gives people the cloud presence line; agents, self and presence details keep theirs', async (t) => {
  setUpPresence(t, [
    { accountId: 'acct_maya', status: 'online', updatedAt: '2026-11-06T12:00:00Z', lastSeenAt: null },
    { accountId: 'acct_ethan', status: 'offline', updatedAt: '2026-11-06T12:00:00Z', lastSeenAt: new Date(Date.now() - 9 * MINUTE).toISOString() },
    { accountId: 'acct_owner', status: 'online', updatedAt: '2026-11-06T12:00:00Z', lastSeenAt: null },
    { accountId: 'acct_priya', status: 'online', updatedAt: '2026-11-06T12:00:00Z', lastSeenAt: null },
  ]);
  await withJsdomRoot(async (mount) => {
    const host = await mount(infoPanel({
      canonicalParticipants: [
        { id: 'human:me', humanId: 'acct_owner', name: 'Me', kind: 'human', role: 'self' },
        { id: 'human:maya', humanId: 'acct_maya', name: 'Maya Chen', kind: 'human', role: 'person' },
        { id: 'human:ethan', humanId: 'acct_ethan', name: 'Ethan Park', kind: 'human', role: 'person' },
        { id: 'human:priya', humanId: 'acct_priya', name: 'Priya Nair', kind: 'human', role: 'person', presenceDetail: 'In a call' },
        { id: 'human:sam', humanId: 'acct_sam', name: 'Sam Okafor', kind: 'human', role: 'person' },
        { id: 'agent:research', agentId: 'research', humanId: 'acct_maya', name: 'Research Agent', kind: 'agent', role: 'agent', ownerName: 'Maya Chen' },
      ],
    }));
    const row = (name: string) => [...host.querySelectorAll('.app-inspector-list-row')]
      .find((item) => item.textContent?.startsWith(name))?.textContent ?? '';
    await waitForReactCondition(() => row('Maya Chen') === 'Maya Chenonline', 'presence arrives');

    assert.ok(host.querySelector('.app-inspector-list-row .app-contacts-presence-online'));
    assert.equal(row('Ethan Park'), 'Ethan Parklast seen 9 minutes ago');
    assert.equal(row('Priya Nair'), 'Priya NairIn a call');
    // No presence record: no line rather than a guess.
    assert.equal(row('Sam Okafor'), 'Sam Okafor');
    assert.equal(row('Research Agent'), 'Research AgentOwner: Maya Chen');
    assert.doesNotMatch(row('You') || row('Me'), /online/);
  });
});

test('Chat Info fallback list shows no presence at all', () => {
  const markup = renderToStaticMarkup(infoPanel({ canonicalParticipants: [] }));
  assert.match(markup, /Maya Chen/);
  assert.doesNotMatch(markup, /Status: online|is online|>online</);
});
