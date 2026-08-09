import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { CloudGroupInvitationCreateInput } from '../src/features/cloud/authClient';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('a group admin can create and revoke a preview-first invitation link', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://kordi.test/',
  });
  // React's legacy input-event fallback probes these IE methods in jsdom.
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => {},
    detachEvent: () => {},
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group:invite-ui',
    canonicalSessionId: 'session:group:invite-ui',
    name: 'Product Team',
    metadata: {
      customName: 'Product Team',
      groupSpaceId: 'session:group:invite-ui',
      groupCreatorIdentityId: 'human:me',
      adminIdentityIds: ['human:me'],
    },
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })]);
  const host = dom.window.document.querySelector('#root') as HTMLElement;
  let root: Root | null = createRoot(host);
  let createInput: CloudGroupInvitationCreateInput | null = null;
  let revokedId = '';
  let activeInvitation: { invitationId: string; expiresAt: string } | null = null;
  let step = 'render';
  try {
    await act(async () => {
      root?.render(createElement(GroupDetailsDialog, {
        isOpen: true,
        space,
        contacts: [],
        onClose: () => {},
        onRename: () => {},
        onAddMembers: () => {},
        onRemoveMember: () => {},
        onSetAdmin: () => {},
        onCreateGroupInvitation: async (input) => {
          createInput = input;
          activeInvitation = {
            invitationId: 'groupinv_ui',
            expiresAt: '2026-08-15T00:00:00Z',
          };
          return {
            invitationId: 'groupinv_ui',
            inviteUrl: 'https://kordi.ai/g/kordi_gi_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12',
            expiresAt: '2026-08-15T00:00:00Z',
          };
        },
        onListGroupInvitations: async () => activeInvitation ? [activeInvitation] : [],
        onRevokeGroupInvitation: async (invitationId) => {
          revokedId = invitationId;
          activeInvitation = null;
        },
      }));
    });

    const button = (label: string) => [...host.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
    step = 'open add people';
    assert.ok(button('Add'));
    await act(async () => { button('Add')?.click(); });
    step = 'open share link';
    assert.ok(button('Share link'));
    await act(async () => { button('Share link')?.click(); });

    step = 'check compact share panel';
    assert.doesNotMatch(host.textContent ?? '', /preview the group and choose whether to join/i);
    assert.doesNotMatch(host.textContent ?? '', /No contact requests are created automatically/);
    step = 'create link';
    assert.ok(button('Create invitation link'));
    await act(async () => { button('Create invitation link')?.click(); });

    assert.deepEqual(createInput, {
      groupId: 'session:group:invite-ui',
      groupSpaceId: 'session:group:invite-ui',
      groupTitle: 'Product Team',
    });
    assert.equal(
      host.querySelector<HTMLInputElement>('input[aria-label="Group invitation link"]')?.value,
      'https://kordi.ai/g/kordi_gi_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12',
    );
    step = 'reopen active link';
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Back to group members"]')?.click();
    });
    await act(async () => { button('Add')?.click(); });
    await act(async () => { button('Share link')?.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(host.textContent ?? '', /invitation link is already active/i);
    step = 'revoke active link';
    assert.ok(button('Revoke active link'));
    await act(async () => { button('Revoke active link')?.click(); });
    assert.equal(revokedId, 'groupinv_ui');
    assert.ok(button('Create invitation link'));
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    throw new Error(`${step}: ${detail}`);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('a regular member can find invitation links and sees who can grant access', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://kordi.test/',
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => {},
    detachEvent: () => {},
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group:member-invite-ui',
    canonicalSessionId: 'session:group:member-invite-ui',
    name: 'Product Team',
    metadata: {
      customName: 'Product Team',
      groupSpaceId: 'session:group:member-invite-ui',
      groupCreatorIdentityId: 'human:jiaxin',
      adminIdentityIds: ['human:jiaxin'],
    },
    participants: ['Jiaxin Pei', 'Me'],
    canonicalParticipants: [
      { id: 'human:jiaxin', name: 'Jiaxin Pei', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'jiaxin' },
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
    ],
  })]);
  const host = dom.window.document.querySelector('#root') as HTMLElement;
  let root: Root | null = createRoot(host);
  let listCalls = 0;
  let createCalls = 0;
  try {
    await act(async () => {
      root?.render(createElement(GroupDetailsDialog, {
        isOpen: true,
        space,
        contacts: [],
        onClose: () => {},
        onRename: () => {},
        onAddMembers: () => {},
        onRemoveMember: () => {},
        onSetAdmin: () => {},
        onCreateGroupInvitation: async () => {
          createCalls += 1;
          throw new Error('regular members must not create links');
        },
        onListGroupInvitations: async () => {
          listCalls += 1;
          return [];
        },
      }));
    });

    const button = (label: string) => [...host.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
    await act(async () => { button('Add')?.click(); });
    assert.ok(button('Share link'), 'Share link should remain discoverable to regular members');
    await act(async () => { button('Share link')?.click(); });

    assert.match(host.textContent ?? '', /Only group admins can create invitation links/);
    assert.match(host.textContent ?? '', /Ask Jiaxin Pei to share a link or make you an admin/);
    assert.equal(button('Create invitation link'), undefined);
    assert.equal(listCalls, 0);
    assert.equal(createCalls, 0);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
