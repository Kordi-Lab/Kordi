import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { PrivacySettingsPanel } from '../src/features/privacy/PrivacySettingsPanel';
import {
  LINK_PREVIEW_PREFERENCE_STORAGE_KEY,
  readLinkPreviewPreference,
  resetLinkPreviewPreferenceForTests,
} from '../src/features/privacy/linkPreviewPolicy';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const CONNECTION_NOTE = 'Loading a preview connects this Mac to the linked website, which can see your IP address and when the link was viewed.';

function installLocalStorage() {
  const values = new Map<string, string>();
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  return {
    values,
    restore() {
      if (previous) Object.defineProperty(target, 'localStorage', previous);
      else Reflect.deleteProperty(target, 'localStorage');
    },
  };
}

afterEach(() => {
  resetLinkPreviewPreferenceForTests();
});

test('the privacy panel offers three link preview choices described for screen readers', () => {
  const html = renderToStaticMarkup(createElement(PrivacySettingsPanel, { isNativeShell: false }));

  assert.match(html, /<h2[^>]*>Privacy<\/h2>/);
  assert.match(html, />Link previews</);
  const select = html.match(/<select[^>]*>/)?.[0] ?? '';
  assert.match(select, /aria-label="Link previews"/);
  const describedBy = select.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy, 'the select points at its description');
  assert.match(html, new RegExp(`<span id="${describedBy}" aria-live="polite">Kordi loads previews and site icons only for links you send`));
  assert.ok(html.includes(CONNECTION_NOTE));
  assert.deepEqual(
    [...html.matchAll(/<option value="([a-z]+)"[^>]*>([^<]+)<\/option>/g)].map((match) => [match[1], match[2]]),
    [['contacts', 'From contacts'], ['everyone', 'Everyone'], ['off', 'Off']],
  );
  assert.doesNotMatch(html, /Messages on this Mac/, 'the local data note is native only');
});

test('the local data note appears only in the native shell', () => {
  const html = renderToStaticMarkup(createElement(PrivacySettingsPanel, { isNativeShell: true }));
  assert.match(html, /<h2[^>]*>Messages on this Mac<\/h2>/);
  assert.match(html, /Kordi doesn(?:'|&#x27;)t add its own encryption to these copies\./);
  assert.match(html, /Turn on FileVault in System Settings/);
});

test('choosing Off persists the setting and swaps the description', async () => {
  const storage = installLocalStorage();
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    resetLinkPreviewPreferenceForTests();
    await act(async () => { root.render(createElement(PrivacySettingsPanel, { isNativeShell: true })); });
    const select = host.querySelector('select');
    assert.ok(select);
    assert.equal(select.value, 'contacts');
    const description = () => document.getElementById(select.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    assert.match(description(), /links from people in your contacts/);

    await act(async () => {
      select.value = 'off';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flushReactUpdates();

    assert.equal(storage.values.get(LINK_PREVIEW_PREFERENCE_STORAGE_KEY), 'off');
    assert.equal(readLinkPreviewPreference(), 'off');
    assert.equal(select.value, 'off');
    assert.equal(
      description(),
      `Kordi doesn't load link previews or site icons. Links show just the web address. ${CONNECTION_NOTE}`,
    );

    await act(async () => {
      select.value = 'everyone';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.match(description(), /^Kordi loads previews and site icons for every link, including links from agents/);
  } finally {
    await act(async () => { root.unmount(); });
    installed.restore();
    storage.restore();
  }
});

test('account settings place Privacy between Notifications and Appearance', () => {
  const source = readFileSync(new URL('../src/pages/CloudAccountSettingsDialog.tsx', import.meta.url), 'utf8');
  assert.match(source, /id: 'notifications'[^\n]*\n\s*\{ id: 'privacy', label: 'Privacy', icon: Hand,[^\n]*\n\s*\{ id: 'appearance'/);
  assert.match(source, /<PrivacySettingsPanel isNativeShell=\{isNativeShell\} \/>/);
  assert.match(source, /activeTab === 'privacy' \? privacyPanel/);
});
