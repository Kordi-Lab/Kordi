import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DEFAULT_LINK_PREVIEW_PREFERENCE,
  LINK_PREVIEW_PREFERENCE_STORAGE_KEY,
  messageAllowsLinkNetwork,
  messageSenderHumanId,
  parseLinkPreviewPreference,
  readLinkPreviewPreference,
  resetLinkPreviewPreferenceForTests,
  setLinkPreviewPreference,
  trustedLinkPreviewHumanIds,
  useLinkPreviewPreference,
  type LinkPreviewPolicyMessage,
  type LinkPreviewPreference,
} from '../src/features/privacy/linkPreviewPolicy';

const trusted = new Set(['acct_self', 'acct_trusted', 'source:x', 'local:x']);

function installStorage(storage: Partial<Storage> | undefined) {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(target, 'localStorage', { configurable: true, writable: true, value: storage });
  return () => {
    if (previous) Object.defineProperty(target, 'localStorage', previous);
    else Reflect.deleteProperty(target, 'localStorage');
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

afterEach(() => {
  resetLinkPreviewPreferenceForTests();
});

const cases: Array<{ name: string; message: LinkPreviewPolicyMessage; contacts: boolean }> = [
  { name: 'own message', message: { role: 'user', senderType: 'human', isOwnMessage: true }, contacts: true },
  { name: 'user role without own flag', message: { role: 'user' }, contacts: true },
  { name: 'trusted human', message: { role: 'person', senderType: 'human', senderHumanId: 'acct_trusted' }, contacts: true },
  { name: 'untrusted human', message: { role: 'person', senderType: 'human', senderHumanId: 'acct_stranger' }, contacts: false },
  { name: 'owned agent', message: { role: 'owned-agent', senderType: 'agent', isOwnMessage: false }, contacts: false },
  { name: 'own agent marked as own', message: { role: 'owned-agent', senderType: 'agent', isOwnMessage: true }, contacts: false },
  { name: 'external agent', message: { role: 'external-agent', senderType: 'agent' }, contacts: false },
  { name: 'agent sender on a person row', message: { role: 'person', senderType: 'agent', senderHumanId: 'acct_trusted' }, contacts: false },
  { name: 'system notice', message: { role: 'system' }, contacts: false },
  { name: 'source-scoped human', message: { role: 'person', senderIdentityId: 'human:source:x' }, contacts: false },
  { name: 'local human', message: { role: 'person', senderIdentityId: 'human:local:x' }, contacts: false },
  { name: 'raw account id', message: { role: 'person', senderIdentityId: 'acct_trusted' }, contacts: true },
  { name: 'prefixed account id', message: { role: 'person', senderIdentityId: 'human:acct_trusted' }, contacts: true },
  {
    name: 'senderHumanId takes precedence over a trusted identity',
    message: { role: 'person', senderHumanId: 'acct_stranger', senderIdentityId: 'human:acct_trusted' },
    contacts: false,
  },
  {
    name: 'senderHumanId takes precedence over an unknown identity',
    message: { role: 'person', senderHumanId: 'acct_trusted', senderIdentityId: 'human:local:x' },
    contacts: true,
  },
  { name: 'unresolved sender', message: { role: 'person' }, contacts: false },
];

test('link network decisions follow the preference, sender kind, and contacts', () => {
  for (const { name, message, contacts } of cases) {
    const expected: Record<LinkPreviewPreference, boolean> = { off: false, everyone: true, contacts };
    for (const preference of ['off', 'everyone', 'contacts'] as const) {
      assert.equal(
        messageAllowsLinkNetwork(preference, message, trusted),
        expected[preference],
        `${preference}: ${name}`,
      );
    }
  }
});

test('sender human ids resolve only cloud account forms', () => {
  assert.equal(messageSenderHumanId({ senderHumanId: ' acct_a ' }), 'acct_a');
  assert.equal(messageSenderHumanId({ senderIdentityId: 'human:acct_b' }), 'acct_b');
  assert.equal(messageSenderHumanId({ senderIdentityId: 'acct_c' }), 'acct_c');
  assert.equal(messageSenderHumanId({ senderIdentityId: 'human:source:node' }), null);
  assert.equal(messageSenderHumanId({ senderIdentityId: 'human:local:abcd' }), null);
  assert.equal(messageSenderHumanId({ senderIdentityId: 'agent:acct_d' }), null);
  assert.equal(messageSenderHumanId({ senderIdentityId: 'human:' }), null);
  assert.equal(messageSenderHumanId({}), null);
});

test('trusted senders include self and human rows of the server contacts list only', () => {
  const ids = trustedLinkPreviewHumanIds({
    selfAccountId: ' acct_self ',
    serverContacts: [
      { accountId: 'acct_contact' },
      { accountId: ' acct_spaced ', contactKind: null, targetCloudAgentId: null },
      { accountId: 'acct_support', contactKind: 'system_agent', targetCloudAgentId: 'agent_support' },
      { accountId: 'acct_system_without_target', contactKind: 'system_agent' },
      { accountId: 'acct_agent_target', targetCloudAgentId: 'agent_x' },
      { accountId: '  ' },
    ],
  });
  assert.deepEqual([...ids].sort(), ['acct_contact', 'acct_self', 'acct_spaced']);
  assert.deepEqual([...trustedLinkPreviewHumanIds({ selfAccountId: null, serverContacts: [] })], []);
});

test('invalid preference values read as the default', () => {
  assert.equal(DEFAULT_LINK_PREVIEW_PREFERENCE, 'contacts');
  assert.equal(parseLinkPreviewPreference('bogus'), 'contacts');
  assert.equal(parseLinkPreviewPreference(null), 'contacts');
  assert.equal(parseLinkPreviewPreference('Everyone'), 'contacts');
  assert.equal(parseLinkPreviewPreference('everyone'), 'everyone');
  assert.equal(parseLinkPreviewPreference('off'), 'off');
});

test('unreadable storage falls back to the default and writes persist under the versioned key', () => {
  const restoreThrowing = installStorage({
    getItem: () => { throw new Error('storage is unavailable'); },
    setItem: () => { throw new Error('storage is unavailable'); },
    removeItem: () => undefined,
  });
  try {
    resetLinkPreviewPreferenceForTests();
    assert.equal(readLinkPreviewPreference(), 'contacts');
    setLinkPreviewPreference('off');
    assert.equal(readLinkPreviewPreference(), 'off', 'a failed write still updates this window');
  } finally {
    restoreThrowing();
  }

  const storage = memoryStorage({ [LINK_PREVIEW_PREFERENCE_STORAGE_KEY]: 'everyone' });
  const restore = installStorage(storage);
  try {
    resetLinkPreviewPreferenceForTests();
    assert.equal(readLinkPreviewPreference(), 'everyone');
    setLinkPreviewPreference('off');
    assert.equal(storage.values.get(LINK_PREVIEW_PREFERENCE_STORAGE_KEY), 'off');
    storage.values.set(LINK_PREVIEW_PREFERENCE_STORAGE_KEY, 'unexpected');
    resetLinkPreviewPreferenceForTests();
    assert.equal(readLinkPreviewPreference(), 'contacts');
  } finally {
    restore();
  }
});

test('static rendering sees the preference set in this window', () => {
  function Probe() {
    return createElement('output', null, useLinkPreviewPreference());
  }
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<output>contacts</output>');
  setLinkPreviewPreference('everyone');
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<output>everyone</output>');
  resetLinkPreviewPreferenceForTests();
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<output>contacts</output>');
});
