import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import { installDom } from './helpers/transcriptAttachmentDom';

// Guards the fix that removed WorkspaceSidebar's remounting `key` on this
// dialog. WorkspaceSidebar always renders <ChatCreateDialog isOpen={...}/>,
// so without that key the component instance (and its hook state) persists
// across an open/close cycle instead of being torn down and recreated --
// which is what makes a real exit animation possible instead of a hard
// unmount. That only stays safe if the dialog resets its own transient
// state on every open; this test is the behavioral proof of that reset.
test('reopening the dialog clears a draft group name left over from a previous session', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  const asyncNoop = async () => undefined;
  try {
    const render = (isOpen: boolean) => act(() => {
      root.render(createElement(ChatCreateDialog, {
        isOpen,
        contacts: [],
        agents: [],
        onClose: noop,
        onStartPerson: noop,
        onStartAgent: noop,
        onCreateGroup: asyncNoop,
        onAddContact: asyncNoop,
        onLookupContact: asyncNoop,
        addContactPlaceholder: 'Kordi ID',
        initialMode: 'group',
      }));
    });

    render(true);
    const input = () => host.querySelector<HTMLInputElement>('input[placeholder="Group name (optional)"]');
    assert.ok(input(), 'the group form must be visible for the group initial mode');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input(), 'A draft nobody submitted');
      input()!.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(input()?.value, 'A draft nobody submitted');

    render(false);
    assert.equal(host.querySelector('input'), null, 'closed dialog renders nothing');

    render(true);
    assert.equal(input()?.value, '', 'a fresh open must not show the previous session\'s draft');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
