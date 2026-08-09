import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { filterGroupManagementMembers, GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { groupManagementGeometry } from '../src/pages/groupManagementGeometry';
import { contactForGroupMember, groupMemberAccountId, MemberContactProfileContent } from '../src/pages/MemberContactProfilePopover';
import { conversation, contact } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('GroupDetailsDialog renders a searchable member gallery with progressive controls', () => {
  const chatConversations = [conversation({
    id: 'session:group-details',
    canonicalSessionId: 'session:group-details',
    name: 'Design crew',
    metadata: { adminIdentityIds: ['human:me'], groupSpaceId: 'session:group-details', customName: 'Design crew' },
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'alice', presenceStatus: 'online' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob', presenceStatus: 'offline' },
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

  assert.match(markup, /data-group-management-surface="popover"/);
  assert.match(markup, /app-group-management-popover/);
  assert.match(markup, /app-frosted-popover/);
  assert.match(markup, /app-group-management-header[^"\n]*shrink-0/);
  assert.match(markup, /app-transient-scroll[^"\n]*overflow-y-auto/);
  assert.doesNotMatch(markup, /bg-slate-950\/70/);
  assert.match(markup, /Group management/);
  assert.doesNotMatch(markup, /lucide-ellipsis/);
  assert.doesNotMatch(markup, />People<\/h3>/);
  assert.match(markup, /placeholder="Search members"/);
  assert.match(markup, /data-group-member-grid/);
  assert.match(markup, /Alice/);
  assert.match(markup, /class="app-presence-light"/);
  assert.match(markup, /data-presence-status="online"/);
  assert.match(markup, /lucide-star/);
  assert.doesNotMatch(markup, />Admin<\/span>|>Member<\/span>|>People<\/span>/);
  assert.match(markup, /aria-label="Add people"/);
  assert.doesNotMatch(markup, /No additional approved contacts available/);
  assert.match(markup, /Group name/);
  assert.doesNotMatch(markup, /Group notice|Mute notifications|Sticky|Local alias|Search chat history/);
  assert.doesNotMatch(markup, /Make group admin/);
  assert.doesNotMatch(markup, /Remove from group/);
});

test('GroupDetailsDialog keeps the member gallery to five compact columns and four rows until Show all is used', () => {
  const canonicalParticipants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local' as const, avatarKey: 'me' },
    ...Array.from({ length: 19 }, (_, index) => ({
      id: `human:member-${index + 1}`,
      name: `Member ${index + 1}`,
      kind: 'human' as const,
      role: 'person' as const,
      source: 'bridge' as const,
      avatarKey: `member-${index + 1}`,
    })),
  ];
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group-many-members',
    canonicalSessionId: 'session:group-many-members',
    name: 'Large group',
    metadata: {
      adminIdentityIds: ['human:me'],
      groupCreatorIdentityId: 'human:me',
      groupSpaceId: 'session:group-many-members',
    },
    participants: canonicalParticipants.map((participant) => participant.name),
    canonicalParticipants,
  })]);
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

  assert.equal(markup.match(/data-group-member-grid-item/g)?.length, 20);
  assert.match(markup, /Show all/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /h-9 w-9/);
  assert.doesNotMatch(markup, /Member 19/);
  assert.ok(
    markup.indexOf('aria-label="Member 18, member"') < markup.indexOf('aria-label="Add people"'),
    'Add people should occupy the final (20th) collapsed-grid slot',
  );
  assert.match(
    readDesktopShellCss(),
    /\.app-group-management-member-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    readDesktopShellCss(),
    /\.app-group-management-member-tile-selected\s*\{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none;/s,
  );
});

test('GroupDetailsDialog labels the canonical group-root creation date instead of session activity', () => {
  const rootCreatedAtMs = new Date(2026, 5, 3, 12).getTime();
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const, avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const, avatarKey: 'bob' },
  ];
  const [space] = buildParticipantSpaces([
    conversation({
      id: 'session:group:created-root',
      canonicalSessionId: 'session:group:created-root',
      canonicalCreatedAtMs: rootCreatedAtMs,
      canonicalCreatedByIdentityId: 'human:me',
      metadata: { groupSpaceId: 'session:group:created-root', adminIdentityIds: ['human:me'] },
      canonicalParticipants: participants,
      participants: participants.map((participant) => participant.name),
      updatedAtLabel: '02:45',
      _updatedAtMs: rootCreatedAtMs + 10_000,
    }),
    conversation({
      id: 'session:group:created-child',
      canonicalSessionId: 'session:group:created-child',
      canonicalCreatedAtMs: rootCreatedAtMs + 20_000,
      canonicalCreatedByIdentityId: 'human:me',
      metadata: { groupSpaceId: 'session:group:created-root', continuedFromSessionId: 'session:group:created-root' },
      canonicalParticipants: participants,
      participants: participants.map((participant) => participant.name),
      updatedAtLabel: '14:30',
      _updatedAtMs: rootCreatedAtMs + 30_000,
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

  assert.equal(space.createdAtMs, rootCreatedAtMs);
  assert.match(markup, /Created 2026-06-03/);
  assert.doesNotMatch(markup, /Created 02:45|Created 14:30/);
});

test('GroupDetailsDialog geometry stays tall, narrow, and inside small and large viewports', () => {
  const desktop = groupManagementGeometry(
    { left: 120, top: 90, width: 28, height: 28 },
    { width: 1280, height: 800 },
  );
  assert.equal(desktop.style.width, 304);
  assert.equal(desktop.style.maxHeight, 760);
  assert.equal(desktop.style.height, undefined);
  assert.ok(Number(desktop.style.left) >= 12);
  assert.ok(Number(desktop.style.top) >= 12);
  assert.ok(Number(desktop.style.left) + Number(desktop.style.width) <= 1268);
  assert.ok(Number(desktop.style.top) + Number(desktop.style.maxHeight) <= 788);

  const compact = groupManagementGeometry(
    { left: 8, top: 8, width: 24, height: 24 },
    { width: 320, height: 420 },
  );
  assert.equal(compact.style.width, 296);
  assert.equal(compact.style.maxHeight, 396);
  assert.equal(compact.style.height, undefined);
  assert.equal(compact.style.left, 12);
  assert.equal(compact.style.top, 12);

  const constrained = groupManagementGeometry(
    { left: 320, top: 180, width: 32, height: 32 },
    { width: 680, height: 600 },
  );
  assert.equal(constrained.placement, 'right');
  assert.equal(constrained.style.left, 362);
  assert.equal(constrained.style.top, 12);
});

test('GroupDetailsDialog member filtering stays bounded and useful with 50 people', () => {
  const members = Array.from({ length: 50 }, (_, index) => ({
    id: `human:${index}`,
    humanId: `acct_${index}`,
    name: index === 37 ? 'Jiaxin Pei' : `Member ${index + 1}`,
    kind: 'human' as const,
    role: 'person' as const,
    source: 'bridge' as const,
    avatarKey: `member-${index}`,
  }));

  assert.equal(filterGroupManagementMembers(members, '').length, 50);
  assert.deepEqual(filterGroupManagementMembers(members, 'jiaxin').map((member) => member.id), ['human:37']);
  assert.deepEqual(filterGroupManagementMembers(members, 'acct_9').map((member) => member.id), ['human:9']);
});

test('GroupDetailsDialog resolves a group-only member to the account used by Add to contacts', () => {
  const member = {
    id: 'human:acct_group_member',
    humanId: 'acct_group_member',
    sourceIdentityId: 'acct_group_member',
    name: 'Group member',
    kind: 'human' as const,
    role: 'person' as const,
    source: 'bridge' as const,
    avatarKey: 'group-member',
  };
  const groupOnlyContact = contact({
    id: 'cloud:acct_group_member',
    sourceHostId: 'cloud',
    sourceParticipantId: 'acct_group_member',
    sourceHumanId: 'acct_group_member',
    contactStatus: 'group-member',
  });

  const resolvedContact = contactForGroupMember([groupOnlyContact], member);
  assert.equal(resolvedContact?.id, groupOnlyContact.id);
  assert.equal(groupMemberAccountId(member, resolvedContact), 'acct_group_member');
});

test('existing group contact profile offers Send message instead of a passive contact label', () => {
  const member = {
    id: 'human:acct_alice',
    humanId: 'acct_alice',
    sourceIdentityId: 'acct_alice',
    name: 'Alice',
    kind: 'human' as const,
    role: 'person' as const,
    source: 'bridge' as const,
    avatarKey: 'alice',
  };
  const acceptedContact = contact({
    id: 'cloud:acct_alice',
    sourceHostId: 'cloud',
    sourceParticipantId: 'acct_alice',
    sourceHumanId: 'acct_alice',
    contactStatus: 'accepted',
  });

  const markup = renderToStaticMarkup(createElement(MemberContactProfileContent, {
    participant: member,
    contacts: [acceptedContact],
    onMessageContact: () => undefined,
  }));

  assert.match(markup, />Send message</);
  assert.match(markup, /data-member-contact-action="message"/);
  assert.match(markup, /aria-label="Send message to Alice"/);
  assert.match(markup, /title="Send message"/);
  assert.match(markup, /class="sr-only">Send message</);
  assert.match(markup, /Works on product/);
  assert.doesNotMatch(markup, />In contacts</);
  assert.doesNotMatch(markup, />Add to contacts</);
  assert.doesNotMatch(markup, /Kordi ID|acct_alice/);
  const actionClass = /data-member-contact-action="message" class="([^"]+)"/.exec(markup)?.[1] ?? '';
  assert.ok(actionClass);
  assert.doesNotMatch(actionClass, /\bw-full\b/);
  assert.match(actionClass, /\bh-7\b/);
  assert.match(actionClass, /\bw-7\b/);
});

test('member profile popover is content-dense, preserves identity text, and dismisses outside', () => {
  const source = readFileSync(
    new URL('../src/pages/MemberContactProfilePopover.tsx', import.meta.url),
    'utf8',
  );
  const markup = renderToStaticMarkup(createElement(MemberContactProfileContent, {
    participant: {
      id: 'human:tom-cohen',
      humanId: 'acct_tom_cohen',
      name: 'Tom Cohen with a longer display name',
      kind: 'human',
      role: 'person',
      source: 'bridge',
      avatarKey: 'tom-cohen',
    },
    contacts: [],
    roleLabel: 'Group member with a longer localized role',
    onAddContact: () => undefined,
  }));

  assert.match(source, /const width = Math\.min\(256, viewportWidth - margin \* 2\);/);
  assert.match(source, /fixed inset-0 z-\[75\][\s\S]*aria-label="Close member profile"[\s\S]*onClick=\{onClose\}/);
  assert.doesNotMatch(source, /app-group-management-close absolute right-2 top-2/);
  assert.doesNotMatch(source, /className=\{cn\('pr-8'/);
  assert.match(markup, /app-transient-identity-title break-words/);
  assert.match(markup, /app-transient-metadata mt-0\.5 break-words/);
  assert.match(markup, /Tom Cohen with a longer display name/);
  assert.match(markup, /Group member with a longer localized role/);
});

test('GroupDetailsDialog treats the signed-in account id as an alias of the local self identity', () => {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group-account-admin',
    canonicalSessionId: 'session:group-account-admin',
    canonicalCreatedByIdentityId: 'acct_me',
    name: 'Account alias group',
    metadata: {
      groupSpaceId: 'session:group-account-admin',
      groupCreatorIdentityId: 'acct_me',
      adminIdentityIds: ['acct_me'],
    },
    participants: ['Me', 'Alice'],
    canonicalParticipants: [
      { id: 'human:local-profile', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
    ],
  })]);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'contact:bob', name: 'Bob' })],
    currentAccountId: 'acct_me',
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /2 people · 1 admin/);
  assert.match(markup, /aria-label="Me, admin"/);
  assert.match(markup, /aria-label="Add people"/);
});
