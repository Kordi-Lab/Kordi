import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { act, createElement } from 'react';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { ParticipantSpaceViewModel } from '../src/kordi-app/types';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

function groupSpace(admin: boolean): ParticipantSpaceViewModel {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group:info',
    canonicalSessionId: 'session:group:info',
    name: 'Launch crew',
    metadata: {
      customName: 'Launch crew',
      groupSpaceId: 'session:group:info',
      groupCreatorIdentityId: admin ? 'human:me' : 'human:maya',
      adminIdentityIds: [admin ? 'human:me' : 'human:maya'],
    },
    participants: ['Me', 'Maya Chen', 'Ethan Park'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:maya', name: 'Maya Chen', kind: 'human', role: admin ? 'person' : 'admin', source: 'bridge', avatarKey: 'maya' },
      { id: 'human:ethan', name: 'Ethan Park', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'ethan' },
    ],
  })]);
  return space;
}

async function renderGroupInfo({ admin }: { admin: boolean }) {
  const installed = installDom();
  const { window } = installed.dom;
  const globals = ['KeyboardEvent', 'HTMLInputElement'] as const;
  const previousGlobals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  const space = groupSpace(admin);
  assert.equal(space.title, 'Launch crew');
  const calls = { closes: 0, renames: [] as Array<[string[], string]>, dissolves: [] as Array<[string, string[]]>, removals: [] as string[] };
  await act(async () => {
    root.render(createElement(GroupDetailsDialog, {
      isOpen: true,
      space,
      contacts: [],
      onClose: () => { calls.closes += 1; },
      onRename: (sessionIds, name) => { calls.renames.push([sessionIds, name]); },
      onAddMembers: () => {},
      onRemoveMember: (_sessionIds, identityId) => { calls.removals.push(identityId); },
      onSetAdmin: () => {},
      onDissolveGroup: (groupSpaceId, sessionIds) => { calls.dissolves.push([groupSpaceId, sessionIds]); },
    }));
  });
  const doc = window.document;
  const button = (label: string) => [...doc.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
  return {
    doc,
    space,
    calls,
    button,
    nameInput: () => doc.querySelector<HTMLInputElement>('input[aria-label="Group name"]'),
    errorLines: () => [...doc.querySelectorAll('[role="alert"], .app-error-line')].map((line) => line.textContent?.trim()),
    pressEnter: async () => {
      const input = doc.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
      await act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      await flushReactUpdates();
    },
    blurName: async () => {
      await act(async () => { doc.querySelector<HTMLInputElement>('input[type="search"]')!.focus(); });
      await flushReactUpdates();
    },
    layout: () => doc.querySelector<HTMLElement>('.app-group-management-level'),
    click: async (element: HTMLElement | undefined | null) => {
      assert.ok(element);
      await act(async () => { element.click(); });
    },
    type: async (value: string) => {
      const input = doc.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    escape: async () => {
      const target = doc.activeElement ?? doc.body;
      await act(async () => {
        target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      globals.forEach((key, index) => {
        const descriptor = previousGlobals[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      });
      installed.restore();
    },
  };
}

test('group Info drops the bottom Group name, Dissolve group and Leave group rows', async () => {
  for (const admin of [true, false]) {
    const view = await renderGroupInfo({ admin });
    try {
      const text = view.doc.body.textContent ?? '';
      assert.doesNotMatch(text, /Group name|Dissolve group|Leave group/);
      assert.equal(view.doc.querySelector('[aria-label="Group settings"]'), null);
      assert.equal(view.doc.querySelector('[data-group-dissolve], [data-group-leave]'), null);
    } finally {
      await view.cleanup();
    }
  }
});

test('admins rename the group by clicking the header name; Enter saves through onRename', async () => {
  const view = await renderGroupInfo({ admin: true });
  try {
    const title = view.button('Rename Launch crew');
    assert.equal(title?.tagName, 'BUTTON', 'a native button, so Enter and Space start editing too');
    assert.ok(title?.querySelector('.app-group-name-pencil svg'), 'the title carries a hover-only pencil');
    await view.click(title);

    const input = view.nameInput();
    assert.ok(input, 'the title becomes an input');
    assert.equal(input.value, 'Launch crew');
    assert.equal(input.required, false, 'no native validation bubble');
    assert.equal(view.doc.activeElement, input);
    assert.equal(view.button('Rename Launch crew'), undefined);
    const save = () => view.button('Save name')!;
    assert.equal(save().disabled, true, 'unchanged names cannot be saved');

    await view.type('  Launch QA  ');
    assert.equal(save().disabled, false);
    await view.pressEnter();
    assert.deepEqual(view.calls.renames.map(([, name]) => name), ['Launch QA']);
    assert.ok(view.calls.renames[0][0].length > 0, 'the rename reaches the group sessions');
    assert.equal(view.nameInput(), null, 'saving closes the editor');
  } finally {
    await view.cleanup();
  }
});

test('an empty group name is refused with one error line, and typing clears it', async () => {
  const view = await renderGroupInfo({ admin: true });
  try {
    await view.click(view.button('Rename Launch crew'));
    await view.type('   ');
    assert.equal(view.button('Save name')!.disabled, true);
    await view.pressEnter();
    await view.pressEnter();
    assert.equal(view.calls.renames.length, 0);
    assert.deepEqual(view.errorLines(), ['Enter a group name.']);
    assert.ok(view.nameInput(), 'the field stays open to fix the name');

    await view.blurName();
    assert.equal(view.calls.renames.length, 0, 'leaving an empty field does not save');
    assert.deepEqual(view.errorLines(), ['Enter a group name.']);

    await view.type('Launch QA');
    assert.deepEqual(view.errorLines(), []);
  } finally {
    await view.cleanup();
  }
});

test('leaving the name field saves a changed name and closes an unchanged one', async () => {
  const view = await renderGroupInfo({ admin: true });
  try {
    await view.click(view.button('Rename Launch crew'));
    await view.blurName();
    assert.equal(view.calls.renames.length, 0, 'an unchanged name is not sent');
    assert.equal(view.nameInput(), null);

    await view.click(view.button('Rename Launch crew'));
    await view.type('Launch QA');
    await view.blurName();
    assert.deepEqual(view.calls.renames.map(([, name]) => name), ['Launch QA']);
    assert.equal(view.nameInput(), null);
  } finally {
    await view.cleanup();
  }
});

test('Escape cancels a rename before it closes group Info', async () => {
  const view = await renderGroupInfo({ admin: true });
  try {
    await view.click(view.button('Rename Launch crew'));
    await view.type('Something else');
    await view.escape();
    await flushReactUpdates();
    assert.equal(view.nameInput(), null);
    assert.equal(view.calls.closes, 0);
    assert.equal(view.calls.renames.length, 0, 'Escape discards the draft');
    assert.ok(view.button('Rename Launch crew'));
    await view.escape();
    assert.equal(view.calls.closes, 1);
  } finally {
    await view.cleanup();
  }
});

test('Manage opens a second level with Dissolve group; Escape and Back step back', async () => {
  const view = await renderGroupInfo({ admin: true });
  try {
    await view.click(view.button('Manage'));
    assert.equal(view.layout()?.dataset.direction, 'forward');
    assert.ok(view.doc.querySelector('[data-group-manage-page]'));
    assert.equal(view.doc.activeElement, view.button('Back'));
    const manage = view.doc.querySelector('[role="group"][aria-label="Manage"]');
    assert.equal(manage?.textContent?.trim(), 'Dissolve group');
    assert.equal(manage?.querySelectorAll('button').length, 1, 'Manage holds only Dissolve group');
    assert.doesNotMatch(view.doc.querySelector('[data-group-manage-page]')?.textContent ?? '', /Group name|Rename/);
    assert.equal(view.nameInput(), null);
    assert.equal(view.doc.querySelector('input[type="search"]'), null, 'the member gallery is replaced');

    await view.escape();
    assert.equal(view.calls.closes, 0);
    assert.equal(view.layout()?.dataset.direction, 'back');
    assert.equal(view.doc.querySelector('[data-group-manage-page]'), null);
    assert.equal(view.doc.activeElement, view.button('Manage'), 'focus returns to Manage');

    await view.click(view.button('Manage'));
    await view.click(view.button('Back'));
    assert.equal(view.doc.querySelector('[data-group-manage-page]'), null);
  } finally {
    await view.cleanup();
  }
});

test('Dissolve group opens the existing confirmation and dissolves the group', async () => {
  const view = await renderGroupInfo({ admin: true });
  try {
    await view.click(view.button('Manage'));
    await view.click(view.button('Dissolve group'));
    const dialog = view.doc.querySelector('[role="dialog"][aria-labelledby="dissolve-group-dialog-title"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /Dissolve Launch crew\?/);
    assert.match(dialog.textContent ?? '', /Everyone loses access to this group\./);
    await view.click([...dialog.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Dissolve'));
    await flushReactUpdates();
    assert.equal(view.calls.dissolves.length, 1);
    assert.equal(view.calls.dissolves[0][0], view.space.id.replace(/^group:/, ''));
  } finally {
    await view.cleanup();
  }
});

test('members see Members and Add people only, and leave from their own tile', async () => {
  const view = await renderGroupInfo({ admin: false });
  try {
    assert.equal(view.button('Rename Launch crew'), undefined);
    assert.equal(view.button('Manage'), undefined);
    assert.equal(view.doc.querySelector('.app-group-name-pencil, [data-group-avatar-menu]'), null);
    const actions = [...view.doc.querySelectorAll('.app-group-profile-actions button')].map((item) => item.textContent?.trim());
    assert.deepEqual(actions, ['Members', 'Add people']);

    await view.click(view.doc.querySelector<HTMLButtonElement>('[aria-label="Me, member"]'));
    await view.click(view.button('Leave group'));
    assert.match(view.doc.body.textContent ?? '', /Leave this group\?/);
    const confirm = [...view.doc.querySelectorAll('.app-group-management-confirm button')]
      .find((candidate) => candidate.textContent?.trim() === 'Leave group') as HTMLButtonElement | undefined;
    await view.click(confirm);
    await flushReactUpdates();
    assert.deepEqual(view.calls.removals, ['human:me']);
  } finally {
    await view.cleanup();
  }
});

test('group Info rename and Manage styles keep the title line and reuse the menu slide', () => {
  const css = readFileSync(new URL('../src/styles/shell-group-info.css', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(index, /@import '\.\/styles\/shell-group-info\.css';/);
  assert.match(css, /\.app-group-name-form \{[^}]*margin: -3px auto;/);
  assert.match(css, /\.app-group-name-input \{[^}]*height: 26px;/);
  assert.match(css, /\.app-group-name-pencil \{[^}]*opacity: 0;/, 'the pencil only shows on hover or keyboard focus');
  assert.match(css, /\.app-group-name-button:hover \.app-group-name-pencil,\s*\.app-group-name-button:focus-visible \.app-group-name-pencil \{\s*opacity: 1;/);
  assert.match(css, /\[data-direction='forward'\] \{\s*animation: app-group-management-level-forward 180ms/);
  assert.match(css, /from \{ opacity: 0; transform: translate3d\(10px, 0, 0\); \}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
