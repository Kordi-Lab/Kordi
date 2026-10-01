import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudContactsPanel } from '../src/features/cloud/CloudContactsPanel';
import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { installDom, flushReactUpdates } from './helpers/transcriptAttachmentDom';

const account: CloudAccount = {
  accountId: 'acct_provider',
  kordiId: '482731906',
  displayName: 'Provider User',
  primaryEmail: 'provider@example.com',
  avatarUrl: 'https://lh3.googleusercontent.com/a/provider-avatar',
  avatar: {
    entityType: 'human',
    entityId: 'acct_provider',
    source: 'uploaded',
    style: 'lorelei',
    seed: 'provider_user_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: 'https://lh3.googleusercontent.com/a/provider-avatar',
    version: 1,
    updatedAt: '2026-08-19T00:00:00Z',
  },
  nodeId: 'node-provider',
  passwordSet: false,
};

test('CloudContactsPanel self card uses the provider image avatar instead of a generated pixel fallback', () => {
  const markup = renderToStaticMarkup(createElement(CloudContactsPanel, {
    account,
    onClose: () => {},
  }));

  const selfAvatarMarkup = markup.slice(markup.indexOf('aria-label="Provider User avatar"'), markup.indexOf('aria-label="Provider User avatar"') + 500);
  assert.match(selfAvatarMarkup, /src="https:\/\/lh3\.googleusercontent\.com\/a\/provider-avatar"/);
  assert.doesNotMatch(selfAvatarMarkup, /shape-rendering="crispEdges"/);
});

test('the auth client no longer offers a one-sided contact add', () => {
  const source = readFileSync(new URL('../src/features/cloud/authClient.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /async addContact\(/);
});

test('CloudContactsPanel sends a contact request instead of adding a contact directly', async () => {
  const dom = installDom();
  // Load the client renderer after the DOM exists so it uses native input events.
  const { createRoot } = await import('react-dom/client');
  const calls: string[] = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/v1/cloud/contacts')) return Response.json({ contacts: [] });
      if (url.includes('/profile')) {
        return Response.json({
          accountId: 'acct_peer',
          kordiId: '123456789',
          displayName: 'Peer Person',
          avatarUrl: null,
          nodeId: null,
          isContact: false,
          isSelf: false,
        });
      }
      return Response.json({
        request: {
          requestId: 'req_1',
          fromAccountId: 'acct_provider',
          toAccountId: 'acct_peer',
          status: 'pending',
          direction: 'outgoing',
          message: null,
          createdAt: '2026-10-01T00:00:00Z',
          decidedAt: null,
          counterpart: null,
        },
      }, { status: 201 });
    },
  });
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: 'acct_provider', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const host = dom.dom.window.document.createElement('div');
  dom.dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(CloudContactsPanel, { account, client, onClose: () => {} }));
    });
    await flushReactUpdates();
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.dom.window.HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, '123456789');
      input.dispatchEvent(new dom.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new dom.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushReactUpdates();
    const sendButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send request');
    assert.ok(sendButton, 'the lookup result offers a request');
    await act(async () => { sendButton.click(); });
    await flushReactUpdates();

    assert.ok(calls.includes('POST http://srv/v1/cloud/contacts/requests'));
    assert.ok(!calls.includes('POST http://srv/v1/cloud/contacts'));
    assert.match(host.textContent ?? '', /Request sent/);
  } finally {
    await act(async () => { root.unmount(); });
    __setSessionBackendForTests(null);
    dom.restore();
  }
});
