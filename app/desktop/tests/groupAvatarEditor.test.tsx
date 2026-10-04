import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { GroupAvatarEditor } from '../src/kordi-app/components/GroupAvatarEditor';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

test('a macOS pointer blur does not discard Upload photo before its click opens the picker', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(GroupAvatarEditor, {
        avatars: [], name: 'Team', onUpload: () => {}, onRemove: () => {},
      }));
    });
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Edit group avatar"]')!;
    await act(async () => trigger.click());
    const upload = host.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    assert.equal(document.activeElement, upload);

    // macOS WebKit blurs buttons with no next focus target on pointer down.
    // The upload action still needs to exist when pointer up delivers click.
    await act(async () => upload.blur());
    assert.ok(upload.isConnected, 'the pointer blur must not remove the pending click target');
    let pickerOpened = 0;
    host.querySelector<HTMLInputElement>('input[type="file"]')!.click = () => { pickerOpened += 1; };
    await act(async () => upload.click());
    assert.equal(pickerOpened, 1);
    assert.equal(host.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

for (const failure of [null, 'Could not open the photo picker.']) {
  test(`native Upload photo invokes the Mac picker and handles ${failure ? 'failure' : 'cancellation'}`, async () => {
    const installed = installDom();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const commands: string[] = [];
    let notified!: () => void;
    const invoked = new Promise<void>(resolve => { notified = resolve; });
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: async (command: string) => {
        commands.push(command);
        notified();
        if (failure) throw failure;
        return null;
      } },
    });
    let uploads = 0;
    let browserPickerOpened = 0;
    try {
      await act(async () => {
        root.render(createElement(GroupAvatarEditor, {
          avatars: [], name: 'Team', onUpload: () => { uploads += 1; }, onRemove: () => {},
        }));
      });
      host.querySelector<HTMLInputElement>('input[type="file"]')!.click = () => { browserPickerOpened += 1; };
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit group avatar"]')!.click());
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
        await invoked;
      });
      await flushReactUpdates();
      assert.deepEqual(commands, ['desktop_pick_avatar_image']);
      assert.equal(browserPickerOpened, 0);
      assert.equal(uploads, 0);
      assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Edit group avatar"]')!.disabled, false);
      assert.equal(host.querySelector('[role="alert"]')?.textContent ?? null, failure);
    } finally {
      await act(async () => root.unmount());
      installed.restore();
    }
  });
}
