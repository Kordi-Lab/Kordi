import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { CloudGroupInvitationCreateInput } from '../src/features/cloud/authClient';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('a group admin sees the group link, copies it, and resets it behind a confirm', async () => {
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
  const createInputs: CloudGroupInvitationCreateInput[] = [];
  const firstUrl = 'https://kordi.ai/g/kordi_gi_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12';
  const resetUrl = 'https://kordi.ai/g/kordi_gi_resetresetresetresetresetresetresetrese';
  let activeInvitation: { invitationId: string; inviteUrl: string; expiresAt: string } | null = null;
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
          createInputs.push(input);
          activeInvitation = input.reset
            ? { invitationId: 'groupinv_reset', inviteUrl: resetUrl, expiresAt: '2026-08-15T00:00:00Z' }
            : activeInvitation ?? { invitationId: 'groupinv_ui', inviteUrl: firstUrl, expiresAt: '2026-08-15T00:00:00Z' };
          return activeInvitation;
        },
        onListGroupInvitations: async () => activeInvitation ? [activeInvitation] : [],
      }));
    });

    const button = (label: string) => [...host.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
    step = 'open add people';
    assert.ok(button('Add'));
    await act(async () => { button('Add')?.click(); });
    step = 'open share link';
    assert.ok(button('Invite with a link'));
    await act(async () => { button('Invite with a link')?.click(); });

    step = 'check compact share panel';
    assert.doesNotMatch(host.textContent ?? '', /preview the group and choose whether to join/i);
    assert.doesNotMatch(host.textContent ?? '', /No contact requests are created automatically/);
    step = 'create link';
    assert.ok(button('Create link'));
    await act(async () => { button('Create link')?.click(); });

    assert.deepEqual(createInputs, [{
      groupId: 'session:group:invite-ui',
      groupSpaceId: 'session:group:invite-ui',
      groupTitle: 'Product Team',
    }]);
    assert.equal(
      host.querySelector<HTMLInputElement>('input[aria-label="Group invitation link"]')?.value,
      firstUrl,
    );
    step = 'copy link';
    let copiedText = '';
    const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copiedText = text; } },
    });
    try {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]')?.click();
        await Promise.resolve();
      });
    } finally {
      if (clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
      else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
    assert.equal(copiedText, 'https://kordi.ai/g/kordi_gi_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12');
    assert.ok(host.querySelector('button[aria-label="Link copied"]'), 'the copy icon turns into a check');
    assert.equal(dom.window.document.querySelector('.app-copy-toast[role="status"]')?.textContent, 'Link copied');
    step = 'reopen shows the same link';
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Back to group members"]')?.click();
    });
    await act(async () => { button('Add')?.click(); });
    await act(async () => { button('Invite with a link')?.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(button('Create link'), undefined, 'an existing link opens straight away');
    assert.equal(
      host.querySelector<HTMLInputElement>('input[aria-label="Group invitation link"]')?.value,
      firstUrl,
    );
    assert.equal(createInputs.length, 1, 'opening the panel never makes a link');
    step = 'reset asks first';
    assert.ok(button('Reset link'));
    await act(async () => { button('Reset link')?.click(); });
    assert.match(host.textContent ?? '', /The current link will stop working/);
    await act(async () => { button('Cancel')?.click(); });
    assert.equal(createInputs.length, 1);
    await act(async () => { button('Reset link')?.click(); });
    await act(async () => { button('Reset')?.click(); });
    assert.equal(createInputs.at(-1)?.reset, true);
    assert.equal(
      host.querySelector<HTMLInputElement>('input[aria-label="Group invitation link"]')?.value,
      resetUrl,
    );
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
      groupCreatorIdentityId: 'human:maya',
      adminIdentityIds: ['human:maya'],
    },
    participants: ['Maya Chen', 'Me'],
    canonicalParticipants: [
      { id: 'human:maya', name: 'Maya Chen', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'maya' },
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
    assert.ok(button('Invite with a link'), 'Share link should remain discoverable to regular members');
    await act(async () => { button('Invite with a link')?.click(); });

    assert.match(host.textContent ?? '', /Only group admins can share a link/);
    assert.match(host.textContent ?? '', /Ask Maya Chen to share a link or make you an admin/);
    assert.equal(button('Create link'), undefined);
    assert.equal(listCalls, 0);
    assert.equal(createCalls, 0);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
