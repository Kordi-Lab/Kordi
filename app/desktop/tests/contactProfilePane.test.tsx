import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  contactProfileVersionFromCapabilities,
  fetchContactProfile,
  normalizeContactProfile,
  removeCloudContact,
  type CloudContactProfile,
} from '../src/features/cloud/contactProfileClient';
import { cloudContactRemover } from '../src/features/cloud/useCloudContactProfileHost';
import type { ContactMuteControl, ContactProfileHost } from '../src/kordi-app/contacts/contactProfileHost';
import type { ContactsPageProps } from '../src/kordi-app/contacts/contactsPageTypes';
import { ContactsPage } from '../src/kordi-app/pages';
import type { Contact } from '../src/kordi-app/types';
import { contact, contactsPageProps } from './helpers/contactsPageFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';

const nadia = contact({
  id: 'cloud:acct_nadia', name: 'Nadia', subtitle: '@482731906', detail: '@482731906',
  sourceHostId: 'cloud', sourceParticipantId: 'acct_nadia', sourceHumanId: 'acct_nadia', presenceStatus: 'online',
});
const nadiaAgent = contact({
  id: 'cloud:acct_nadia_agent', name: 'Nadia’s agent', classType: 'other-users-agents', subtitle: 'Agent', detail: '@482731907',
  sourceHostId: 'cloud', sourceParticipantId: 'acct_nadia_agent', sourceHumanId: 'acct_nadia_agent',
});
const support = contact({
  id: 'cloud:acct_support', name: 'Kordi Support', subtitle: 'Kordi', detail: 'Kordi', systemContact: true, locked: true,
  sourceHostId: 'cloud', sourceParticipantId: 'acct_support',
});
const ownAgent = contact({ id: 'agent:mine', name: 'My Kordi', classType: 'my-agents', subtitle: 'On this Mac', detail: '', sourceHostId: 'cloud', sourceParticipantId: 'acct_me' });

function profile(overrides: Partial<CloudContactProfile> = {}): CloudContactProfile {
  return normalizeContactProfile({
    accountId: 'acct_nadia',
    kordiId: '482731906',
    displayName: 'Nadia',
    about: 'Robotics PhD at KAUST.',
    kind: 'person',
    presence: { status: 'online', lastSeenAt: null },
    defaultAgent: { agentId: 'agent_n', accountId: 'acct_nadia_agent', displayName: 'Nadia’s agent', avatarUrl: null },
    contactSince: '2026-08-12T09:30:00Z',
    shared: {
      mediaCount: 24, linkCount: 9, documentCount: 3,
      groups: [{ groupId: 'gs_1', title: 'Robotics reading group', avatarUrl: null }, { groupId: 'gs_2', title: 'Lab', avatarUrl: null }],
    },
    commonGround: { workingOn: ['tabletop manipulation', 'sim-to-real'], canHelp: ['grant writing'], lookingFor: [] },
    ...overrides,
  })!;
}

type Calls = { messaged: string[]; selected: string[]; groups: string[]; agents: string[]; muted: boolean[] };

function hostFor(byAccount: Record<string, CloudContactProfile | Error>, calls: Calls, contacts: Contact[] = []): ContactProfileHost {
  return {
    accountIdFor: (picked) => (picked.classType === 'my-agents' ? null : picked.sourceParticipantId ?? null),
    load: async (accountId) => {
      const value = byAccount[accountId];
      if (!value || value instanceof Error) throw value ?? new Error('missing');
      return value;
    },
    contactForAccount: (accountId) => contacts.find((item) => item.sourceParticipantId === accountId) ?? null,
    selectContact: (picked) => { calls.selected.push(picked.id); },
    openAgentChat: (agent) => { calls.agents.push(agent.agentId); },
    openGroup: (group) => { calls.groups.push(group.groupId); },
  };
}

function newCalls(): Calls {
  return { messaged: [], selected: [], groups: [], agents: [], muted: [] };
}

async function mount(props: Partial<ContactsPageProps>) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ContactsPage, contactsPageProps({ contactOverlayMode: 'contact', ...props })));
  });
  // Let the profile request settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    host,
    text: () => host.textContent ?? '',
    tiles: () => [...host.querySelectorAll('.app-contacts-tiles > * ')].map((tile) => tile.textContent?.trim()),
    click: (element: Element | null | undefined) => act(async () => {
      assert.ok(element, 'element to click should exist');
      element.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true }));
    }),
    button: (text: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim().startsWith(text)),
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

test('the capability flag gates the profile route', () => {
  assert.equal(contactProfileVersionFromCapabilities(null), null);
  assert.equal(contactProfileVersionFromCapabilities({}), null);
  assert.equal(contactProfileVersionFromCapabilities({ contactProfileVersion: 0 }), null);
  assert.equal(contactProfileVersionFromCapabilities({ contactProfileVersion: 1 }), 1);
});

test('fetchContactProfile calls the contact profile route and normalizes the body', async () => {
  const seen: { path: string; auth: string }[] = [];
  const result = await fetchContactProfile('acct_nadia', {
    token: async () => 'tok',
    request: async <T,>(path: string, init: RequestInit) => {
      seen.push({ path, auth: String((init.headers as Record<string, string>).authorization) });
      return { accountId: 'acct_nadia', kind: 'agent', owner: { accountId: 'acct_o', displayName: 'Olu' }, shared: { mediaCount: -2, groups: [{ title: 'no id' }] } } as T;
    },
  });
  assert.deepEqual(seen, [{ path: '/v1/cloud/contacts/acct_nadia/profile', auth: 'Bearer tok' }]);
  assert.equal(result.kind, 'agent');
  assert.equal(result.owner?.displayName, 'Olu');
  assert.equal(result.defaultAgent, null);
  assert.deepEqual(result.shared, { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] });
  assert.equal(result.commonGround, null);
  await assert.rejects(fetchContactProfile('acct_nadia', { token: async () => null }));
});

test('profile normalization follows the server shapes for agents, groups, and default agents', () => {
  const person = normalizeContactProfile({
    accountId: 'acct_p', kind: 'person', kordiId: '1', presence: null,
    defaultAgent: { agentId: 'ag', accountId: 'cloud-agent:acct_p', displayName: 'P agent', avatarUrl: 'kordi-avatar://x', avatar: { seed: 'seed-1' } },
    shared: { mediaCount: 1, linkCount: 0, documentCount: 0, groups: [{ groupId: 'gs', title: null, avatarUrl: 'kordi-avatar://g' }] },
  })!;
  assert.equal(person.defaultAgent?.avatarSeed, 'seed-1');
  assert.equal(person.defaultAgent?.avatarUrl, 'kordi-avatar://x');
  assert.deepEqual(person.shared.groups, [{ groupId: 'gs', title: 'Group', avatarUrl: 'kordi-avatar://g' }]);
  assert.equal(person.presence, null);
  const agent = normalizeContactProfile({ accountId: 'acct_a', kind: 'agent', kordiId: null, presence: null, commonGround: null, shared: { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] } })!;
  assert.equal(agent.kordiId, null);
  assert.equal(agent.commonGround, null);
});

test('without the flag the pane keeps today\'s content', () => {
  const markup = renderToStaticMarkup(createElement(ContactsPage, contactsPageProps({
    contactOverlayMode: 'contact', activeContact: nadia, onMessageContact: () => undefined, onRemoveContact: () => undefined,
  })));
  assert.match(markup, />Message</);
  assert.match(markup, /aria-label="More actions"/);
  assert.doesNotMatch(markup, />Mute<|>Share<|Shared with you|Common ground|Contact since|app-contacts-detail-wash/);
  assert.match(markup, />Kordi ID</);
  assert.match(markup, /Delete contact/);
});

test('a person profile fills the info, shared, and common ground cards', async () => {
  const calls = newCalls();
  const mute: ContactMuteControl = { isMuted: () => false, setMuted: (_c, muted) => { calls.muted.push(muted); } };
  const page = await mount({
    activeContact: nadia,
    contactProfileHost: hostFor({ acct_nadia: profile() }, calls),
    contactMute: mute,
    onMessageContact: (picked) => { calls.messaged.push(picked.id); },
    onRemoveContact: () => undefined,
  });
  try {
    assert.deepEqual(page.tiles(), ['Message', 'Mute', 'Share', 'More']);
    const text = page.text();
    assert.match(text, /@482731906Kordi ID/);
    assert.match(text, /Robotics PhD at KAUST\.About/);
    assert.match(text, /Nadia’s agentTheir agent/);
    assert.match(text, /12 Aug 2026Contact since/);
    assert.match(text, /Shared with you/);
    assert.match(text, /Photos and files24/);
    assert.match(text, /Links9/);
    assert.match(text, /Documents3/);
    assert.match(text, /Groups in common2/);
    assert.match(text, /Common ground/);
    assert.match(text, /Working ontabletop manipulationsim-to-real/);
    assert.match(text, /Can helpgrant writing/);
    assert.doesNotMatch(text, /Looking for/);
    assert.doesNotMatch(text, /SHARED|COMMON GROUND/);
    assert.ok(text.indexOf('Common ground') < text.lastIndexOf('Delete contact'), 'delete stays last');

    await page.click(page.button('Mute'));
    assert.deepEqual(calls.muted, [true]);
    await page.click(page.button('Their agent') ?? page.button('Nadia’s agent'));
    assert.deepEqual(calls.agents, ['agent_n']);
    await page.click(page.button('Links'));
    assert.deepEqual(calls.messaged, ['cloud:acct_nadia']);

    await page.click(page.button('Groups in common'));
    const groupMenu = page.host.querySelector('[role="menu"][aria-label="Groups in common"]');
    assert.ok(groupMenu, 'two groups open a list');
    const menuAvatars = [...groupMenu.querySelectorAll('.app-group-avatar')];
    assert.equal(menuAvatars.length, 2);
    assert.ok(menuAvatars.every((avatar) => !avatar.classList.contains('rounded-full')), 'group avatars stay square');
    await page.click([...groupMenu.querySelectorAll('button')].find((button) => button.textContent === 'Lab'));
    assert.deepEqual(calls.groups, ['gs_2']);

    await page.click(page.button('Share'));
    const share = page.host.querySelector('[role="dialog"][aria-label="Share Kordi ID"]');
    assert.ok(share);
    assert.match(share.textContent ?? '', /@482731906Copy/);

    await page.click(page.host.querySelector('[aria-label="More actions"]'));
    const items = [...page.host.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    assert.deepEqual(items.map((item) => [item.textContent, item.disabled]), [['Block', true], ['Report', true], ['Delete contact', false]]);
    await page.click(items[2]);
    assert.match(page.text(), /Deleting removes both contact directions/);
  } finally {
    await page.cleanup();
  }
});

test('one group in common opens it directly and empty counts read "Nothing shared yet"', async () => {
  const calls = newCalls();
  const page = await mount({
    activeContact: nadia,
    contactProfileHost: hostFor({ acct_nadia: profile({ shared: { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [{ groupId: 'gs_1', title: 'Robotics', avatarUrl: null }] } }) }, calls),
  });
  try {
    await page.click(page.button('Groups in common'));
    assert.deepEqual(calls.groups, ['gs_1']);
    assert.equal(page.host.querySelector('[aria-label="Groups in common"][role="menu"]'), null);
  } finally {
    await page.cleanup();
  }
  const empty = await mount({
    activeContact: nadia,
    contactProfileHost: hostFor({ acct_nadia: profile({ shared: { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [] }, commonGround: null }) }, newCalls()),
  });
  try {
    assert.match(empty.text(), /Shared with youNothing shared yet/);
    assert.doesNotMatch(empty.text(), /Photos and files|Common ground/);
    assert.deepEqual(empty.tiles(), ['Message', 'Mute', 'Share', 'More']);
    assert.equal((empty.button('Mute') as HTMLButtonElement).disabled, true, 'mute waits for a mute control');
  } finally {
    await empty.cleanup();
  }
});

test('an agent profile shows the owner row, which selects the owner contact', async () => {
  const calls = newCalls();
  const agentProfile = normalizeContactProfile({
    accountId: 'acct_nadia_agent', kordiId: '482731907', kind: 'agent',
    owner: { accountId: 'acct_nadia', kordiId: '482731906', displayName: 'Nadia', avatarUrl: null },
    shared: { mediaCount: 6, linkCount: 2, documentCount: 5, groups: [] },
  })!;
  const page = await mount({
    activeContact: nadiaAgent,
    contactProfileHost: hostFor({ acct_nadia_agent: agentProfile }, calls, [nadia]),
    onMessageContact: () => undefined,
  });
  try {
    assert.deepEqual(page.tiles(), ['Message', 'Share', 'More']);
    assert.match(page.text(), /Agent · owned by Nadia/);
    assert.match(page.text(), /AgentType/);
    assert.match(page.text(), /NadiaOwner/);
    await page.click(page.button('Nadia'));
    assert.deepEqual(calls.selected, ['cloud:acct_nadia']);
  } finally {
    await page.cleanup();
  }
});

test('system and own-agent contacts get their own tile sets', async () => {
  const system = await mount({
    activeContact: support,
    contactProfileHost: hostFor({ acct_support: normalizeContactProfile({ accountId: 'acct_support', kind: 'system', about: 'Help with your account and the app.' })! }, newCalls()),
    onMessageContact: () => undefined,
  });
  try {
    assert.deepEqual(system.tiles(), ['Message']);
    assert.match(system.text(), /Help with your account and the app\.About/);
    assert.doesNotMatch(system.text(), /Shared with you|Delete contact/);
  } finally {
    await system.cleanup();
  }

  let opened = 0;
  const host = hostFor({}, newCalls());
  const own = await mount({
    activeContact: ownAgent,
    // The own agent has no server profile; the host is present because the server offers the route.
    contactProfileHost: { ...host, accountIdFor: () => 'acct_me', load: () => new Promise(() => undefined) },
    onOpenAgentSettings: () => { opened += 1; },
  });
  try {
    assert.deepEqual(own.tiles(), ['Message', 'Settings', 'More']);
    assert.match(own.text(), /Your agent/);
    await own.click(own.button('Settings'));
    assert.equal(opened, 1);
    await own.click(own.host.querySelector('[aria-label="More actions"]'));
    const items = [...own.host.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    assert.deepEqual(items.map((item) => [item.textContent, item.disabled]), [['Share', true]]);
  } finally {
    await own.cleanup();
  }
});

test('a failed profile request leaves today\'s info card in place', async () => {
  const page = await mount({
    activeContact: nadia,
    contactProfileHost: hostFor({ acct_nadia: new Error('boom') }, newCalls()),
    onRemoveContact: () => undefined,
  });
  try {
    assert.match(page.text(), /@482731906Kordi ID/);
    assert.doesNotMatch(page.text(), /Shared with you|Contact since|boom/);
    assert.equal(page.host.querySelector('[aria-busy="true"]'), null);
    assert.match(page.text(), /Delete contact/);
  } finally {
    await page.cleanup();
  }
});

test('hosted removal deletes the contact, refreshes the list, then closes the pane', async () => {
  const requests: { path: string; method: string | undefined }[] = [];
  const steps: string[] = [];
  const remove = cloudContactRemover({
    remove: (accountId) => removeCloudContact(accountId, {
      token: async () => 'tok',
      request: async <T,>(path: string, init: RequestInit) => {
        requests.push({ path, method: init.method });
        steps.push('delete');
        return undefined as T;
      },
    }),
    refresh: async () => { steps.push('refresh'); },
    close: () => { steps.push('close'); },
  });
  await remove(nadia);
  assert.deepEqual(requests, [{ path: '/v1/cloud/contacts/acct_nadia', method: 'DELETE' }]);
  assert.deepEqual(steps, ['delete', 'refresh', 'close']);

  await assert.rejects(remove(support), /cannot be deleted/);
  const failing = cloudContactRemover({
    remove: async () => { throw new Error('Could not delete contact.'); },
    refresh: async () => { steps.push('refresh-after-failure'); },
    close: () => { steps.push('close-after-failure'); },
  });
  await assert.rejects(failing(nadia), /Could not delete contact/);
  assert.deepEqual(steps, ['delete', 'refresh', 'close'], 'a failed delete neither refreshes nor closes');
});

test('the confirm step drives the hosted removal handler', async () => {
  const removed: string[] = [];
  const page = await mount({
    activeContact: nadia,
    contactProfileHost: hostFor({ acct_nadia: profile() }, newCalls()),
    onRemoveContact: cloudContactRemover({
      remove: async (accountId) => { removed.push(accountId); },
      refresh: async () => undefined,
      close: () => undefined,
    }),
  });
  try {
    await page.click(page.button('Delete contact'));
    assert.match(page.text(), /Deleting removes both contact directions/);
    assert.deepEqual(removed, []);
    await page.click([...page.host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Delete'));
    assert.deepEqual(removed, ['acct_nadia']);
  } finally {
    await page.cleanup();
  }
});

test('the status line follows the profile presence, and a stock agent is named after its owner', async () => {
  const bare = contact({
    id: 'cloud:acct_nadia', name: 'Nadia Haddad', subtitle: '@482731906', detail: '@482731906',
    sourceHostId: 'cloud', sourceParticipantId: 'acct_nadia', sourceHumanId: 'acct_nadia',
  });
  const page = await mount({
    activeContact: bare,
    contactProfileHost: hostFor({
      acct_nadia: profile({
        displayName: 'Nadia Haddad',
        presence: { status: 'offline', lastSeenAt: new Date(Date.now() - 6 * 60_000).toISOString() },
        defaultAgent: { agentId: 'agent_n', accountId: 'cloud-agent:acct_nadia', displayName: 'Kordi', avatarUrl: null, avatarSeed: null },
      }),
    }, newCalls()),
  });
  try {
    const line = page.host.querySelector('.app-contacts-detail-presence');
    assert.equal(line?.textContent, 'last seen 6 minutes ago');
    assert.ok(line?.classList.contains('app-contacts-muted'));
    assert.match(page.text(), /Nadia Haddad's KordiTheir agent/);
  } finally {
    await page.cleanup();
  }
});

test('before the profile loads the status line uses the list presence', async () => {
  const page = await mount({
    activeContact: nadia,
    contactProfileHost: { ...hostFor({}, newCalls()), load: () => new Promise(() => undefined) },
  });
  try {
    const line = page.host.querySelector('.app-contacts-detail-presence');
    assert.equal(line?.textContent, 'online');
    assert.ok(line?.classList.contains('app-contacts-presence-online'));
  } finally {
    await page.cleanup();
  }
});
