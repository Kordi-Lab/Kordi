import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudContactsAdapter, resolveCloudActiveContact } from '../src/features/cloud/CloudContactsAdapter';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import type { CloudAccount } from '../src/features/cloud/authClient';
import type { Contact } from '../src/kordi-app/types';
import { readKordiAppModelImplementationSource } from './helpers/appModelSource';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'collaboration-peer-person:acct_peer:acct_peer',
    name: 'Shuyhere',
    initials: 'SH',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: "Owner of Shuyhere's Kordi",
    collaborationSources: ['cloud'],
    status: 'Reachable',
    discoverableOn: ['cloud'],
    detail: 'acct_peer',
    owner: 'Shuyhere',
    sourceHostId: 'cloud',
    sourceParticipantId: 'acct_peer',
    sourceRuntime: 'person',
    sourceHumanId: 'acct_peer',
    avatarSeed: 'acct_peer',
    profileImageUrl: null,
    ...overrides,
  };
}

test('resolveCloudActiveContact maps stale Cloud self selection to the visible Cloud contact', () => {
  const cloudContact = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Peer',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });
  const staleSelfContact = contact({
    id: 'collaboration-self:cloud',
    name: 'Me',
    classType: 'my-agents',
    entityType: 'My agent',
    subtitle: 'Direct local chat',
    detail: 'Chat directly with my local Kordi agent. Bridge host: kordi.cloud • acct_me',
    sourceHostId: 'cloud',
    sourceParticipantId: 'acct_me',
    sourceRuntime: 'kordi-desktop',
  });

  const resolved = resolveCloudActiveContact({
    account,
    activeContactId: 'collaboration-self:cloud',
    parentActiveContact: staleSelfContact,
    cloudContacts: [cloudContact],
    visibleCloudContacts: [cloudContact],
  });

  assert.equal(resolved?.id, cloudContact.id);
  assert.equal(resolved?.name, 'Peer');
  assert.equal(resolved?.sourceParticipantId, 'acct_peer');
});

test('CloudContactsAdapter hides Cloud self agent rows and local-agent detail copy', () => {
  const markup = renderToStaticMarkup(createElement(CloudContactsAdapter, {
    account,
    contactsPageProps: {
      filteredGroupedContacts: [
        { id: 'my-agents', label: 'My agents', items: [contact({
          id: 'collaboration-self:cloud',
          name: 'Me',
          classType: 'my-agents',
          entityType: 'My agent',
          subtitle: 'Direct local chat',
          detail: 'Chat directly with my local Kordi agent. Bridge host: kordi.cloud • acct_me',
          sourceHostId: 'cloud',
          sourceParticipantId: 'acct_me',
          sourceRuntime: 'kordi-desktop',
        })] },
      ],
      contactSearch: '',
      onContactSearchChange: () => {},
      expandedContactGroups: { 'my-agents': true, 'other-users': true },
      onToggleGroup: () => {},
      activeContactId: '',
      activeContact: contact({ id: 'cloud:acct_peer' }),
      activeContactRequestId: '',
      activeContactRequest: undefined,
      contactOverlayMode: null,
      onCloseOverlay: () => {},
      getStatusBadgeClass: () => '',
      addableContacts: [],
      contactRequests: [],
      onAcceptRequest: () => {},
      onRejectRequest: () => {},
      onAddContactByNodeId: () => {},
      onMessageContact: () => {},
    },
  } as never));

  assert.doesNotMatch(markup, /My agents/);
  assert.doesNotMatch(markup, /My agent • Direct local chat/);
  assert.doesNotMatch(markup, /Chat directly with my local Kordi agent/);
});

test('Cloud contact selection validation uses the rendered Cloud contact rows', () => {
  const appModelSource = readKordiAppModelImplementationSource();
  const cloudCollaborationTopologySource = readFileSync(new URL('../src/features/cloud/useCloudCollaborationTopology.ts', import.meta.url), 'utf8');

  assert.match(
    cloudCollaborationTopologySource,
    /cloudContacts:\s*contacts\.contacts/,
    'Cloud bridge state should expose the same contacts rendered by CloudContactsAdapter',
  );
  assert.match(
    appModelSource,
    /displayedContacts:\s*cloudAwareDisplayedContacts/,
    'contact selection reset must validate against Cloud contacts in Cloud edition, not stale parent contacts',
  );
});

test('CloudContactsAdapter shows one human row and removes other people agent groups', () => {
  const cloudContact = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Shuyhere',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });

  const markup = renderToStaticMarkup(createElement(CloudContactsAdapter, {
    account,
    contactsPageProps: {
      filteredGroupedContacts: [
        { id: 'other-users', label: 'Other users', items: [contact()] },
        { id: 'other-users-agents', label: "Other users' agents", items: [contact({
          id: 'collaboration-peer-agent:acct_peer:cloud-agent',
          classType: 'other-users-agents',
          entityType: 'External agent',
          subtitle: 'kordi-desktop',
          detail: "Shuyhere's Kordi",
          sourceRuntime: 'kordi-desktop',
        })] },
      ],
      contactSearch: '',
      onContactSearchChange: () => {},
      expandedContactGroups: { 'other-users': true, 'other-users-agents': true },
      onToggleGroup: () => {},
      activeContactId: cloudContact.id,
      activeContact: cloudContact,
      activeContactRequestId: '',
      activeContactRequest: undefined,
      addableContacts: [],
      contactRequests: [],
      onAcceptRequest: () => {},
      onRejectRequest: () => {},
      onAddContactByNodeId: () => {},
      onMessageContact: () => {},
    },
  } as never));

  assert.match(markup, /Other users/);
  assert.doesNotMatch(markup, /Other users&#x27; agents|Other users' agents/);
  assert.doesNotMatch(markup, /Owner of Shuyhere/);
});
