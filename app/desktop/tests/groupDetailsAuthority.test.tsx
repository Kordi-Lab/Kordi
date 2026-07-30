import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { conversation, contact } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('GroupDetailsDialog keeps Add people after the final member for a regular member', () => {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group-open-invites',
    canonicalSessionId: 'session:group-open-invites',
    canonicalCreatedByIdentityId: 'human:jiaxin',
    name: 'Open invite group',
    metadata: {
      groupSpaceId: 'session:group-open-invites',
      groupCreatorIdentityId: 'human:jiaxin',
      adminIdentityIds: ['human:jiaxin'],
      memberApprovalPolicy: 'under-50-open',
    },
    participants: ['Jiaxin Pei', 'Me', 'C UFishAI', 'Shenzhe Zhu', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:jiaxin', name: 'Jiaxin Pei', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'jiaxin' },
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:ufish', name: 'C UFishAI', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'ufish' },
      { id: 'human:shenzhe', name: 'Shenzhe Zhu', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shenzhe' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })]);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'contact:bob', name: 'Bob' })],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.equal(markup.match(/data-group-member-grid-item/g)?.length, 7);
  assert.match(markup, /aria-label="Me, member"/);
  assert.match(markup, /aria-label="Add people"/);
  assert.ok(
    markup.indexOf('aria-label="Bob, member"') < markup.indexOf('aria-label="Add people"'),
    'Add people should follow every member when the full gallery fits',
  );
});

test('GroupDetailsDialog ignores a child session that falsely promotes its local creator', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      canonicalCreatedByIdentityId: 'human:old-admin',
      name: '1111',
      metadata: { adminIdentityIds: ['human:old-admin'], groupSpaceId: 'session:group:root', customName: '1111' },
      participants: ['Me', 'Old Admin', 'Shu Yang'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:old-admin', name: 'Old Admin', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'old' },
        { id: 'human:acct_new', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'new', humanId: 'acct_new', sourceIdentityId: 'acct_new', sourceHostId: 'cloud' },
      ],
    }),
    conversation({
      id: 'session:group:child',
      canonicalSessionId: 'session:group:child',
      canonicalCreatedByIdentityId: 'human:acct_new',
      name: '1111',
      metadata: { adminIdentityIds: ['human:acct_new'], groupSpaceId: 'session:group:root', customName: '1111' },
      participants: ['Me', 'Old Admin', 'Shu Yang'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:old-admin', name: 'Old Admin', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'old' },
        { id: 'human:acct_new', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'new', humanId: 'acct_new', sourceIdentityId: 'acct_new', sourceHostId: 'cloud' },
      ],
    }),
  ];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Shu Yang, member"/);
  assert.match(markup, /aria-label="Old Admin, admin"/);
});

test('GroupDetailsDialog uses the newest replicated admin revision for demotions', () => {
  const participants = [
    { id: 'human:creator', name: 'Creator', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'creator' },
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'alice' },
  ];
  const [space] = buildParticipantSpaces([
    conversation({
      id: 'session:group:admin-root',
      canonicalSessionId: 'session:group:admin-root',
      canonicalCreatedByIdentityId: 'human:creator',
      metadata: {
        groupSpaceId: 'session:group:admin-root',
        groupCreatorIdentityId: 'human:creator',
        adminIdentityIds: ['human:creator'],
        groupAdminUpdatedAtMs: 20,
      },
      canonicalParticipants: participants,
      participants: ['Creator', 'Me', 'Alice'],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:admin-child',
      canonicalSessionId: 'session:group:admin-child',
      canonicalCreatedByIdentityId: 'human:me',
      metadata: {
        groupSpaceId: 'session:group:admin-root',
        adminIdentityIds: ['human:creator', 'human:alice'],
        groupAdminUpdatedAtMs: 10,
      },
      canonicalParticipants: participants,
      participants: ['Creator', 'Me', 'Alice'],
      _updatedAtMs: 2,
    }),
  ]);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Creator, admin"/);
  assert.match(markup, /aria-label="Alice, member"/);
});

test('GroupDetailsDialog disambiguates same-name members before progressively opening add contacts', () => {
  const chatConversations = [conversation({
    id: 'session:group:same-name',
    canonicalSessionId: 'session:group:same-name',
    name: 'Same names',
    metadata: { adminIdentityIds: ['human:me'], groupSpaceId: 'session:group:same-name' },
    participants: ['Me', 'Shu Yang'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:acct_a', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'a', humanId: 'acct_a', sourceIdentityId: 'acct_a', sourceHostId: 'cloud' },
    ],
  })];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'cloud:acct_b', name: 'Shu Yang', sourceHostId: 'cloud', sourceParticipantId: 'acct_b', sourceHumanId: 'acct_b', contactStatus: 'accepted' })],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /acct_a/);
  assert.doesNotMatch(markup, /acct_b/);
  assert.match(markup, /aria-label="Add people"/);
});

test('GroupDetailsDialog derives admins from group metadata instead of local self role', () => {
  const chatConversations = [conversation({
    id: 'session:group-admin-source',
    canonicalSessionId: 'session:group-admin-source',
    name: 'Bridge group',
    metadata: { adminIdentityIds: ['human:creator'], groupSpaceId: 'session:group-admin-source' },
    participants: ['Me', 'Testuser2', 'Testuser3'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Testuser1', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:creator', name: 'Testuser2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser2' },
      { id: 'human:testuser3', name: 'Testuser3', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser3' },
    ],
  })];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'contact:chen', name: 'Chen' })],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Testuser2, admin"/);
  assert.match(markup, /aria-label="Testuser1, member"/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*aria-expanded="false"[^>]*>[\s\S]*?Group name/);
  assert.match(markup, /aria-label="Add people"/);
});

test('GroupDetailsDialog falls back to canonical creator when admin metadata is missing', () => {
  const chatConversations = [conversation({
    id: 'session:group-legacy-admin',
    canonicalSessionId: 'session:group-legacy-admin',
    canonicalCreatedByIdentityId: 'human:me',
    name: 'Legacy group',
    metadata: { groupSpaceId: 'session:group-legacy-admin' },
    participants: ['Me', 'Testuser1', 'Testuser3'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Testuser2', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:testuser1', name: 'Testuser1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser1' },
      { id: 'human:testuser3', name: 'Testuser3', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser3' },
    ],
  })];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Testuser2, admin"/);
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*aria-expanded="false"[^>]*>[\s\S]*?Group name/);
});
