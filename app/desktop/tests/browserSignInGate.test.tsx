import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import type { AppSignInResult } from '../src/features/cloud/appSignIn/appSignInClient';
import type { BrowserSignInDriver } from '../src/features/cloud/appSignIn/browserSignIn';
import type { CloudBrowserSignInSession } from '../src/features/cloud/appSignIn/cloudBrowserSignInSession';
import { CloudSignInGate } from '../src/kordi-app/cloud/CloudSignInGate';
import { installDom } from './helpers/transcriptAttachmentDom';

const ACCOUNT = { accountId: 'acct_synthetic', email: 'a@example.test', displayName: 'Synthetic' };
const TOKEN_BODY = {
  access_token: 'kordi_cs_synthetic', expires_in: 3600, refresh_token: 'kordi_rt_synthetic',
  device_id: 'dev_synthetic', account: ACCOUNT,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let baseUrlCounter = 0;

function fakeSession({ probeStatus = 400, probeError = 'invalid_redirect_uri' } = {}) {
  const events: string[] = [];
  const completed: AppSignInResult[] = [];
  let state = '';
  let returnFromBrowser: (query: string) => void = () => {};
  let rejectWait: (error: Error) => void = () => {};
  const driver: BrowserSignInDriver = {
    prepare: async (expected) => {
      state = expected;
      return { requestId: 'req_1', redirectUrl: 'http://127.0.0.1:4321/auth/callback' };
    },
    wait: () => new Promise((resolve, reject) => { returnFromBrowser = resolve; rejectWait = reject; }),
    cancel: async () => { events.push('cancel'); rejectWait(new Error('Browser sign-in was canceled.')); },
    openUrl: async (url) => { events.push(`open ${new URL(url).pathname}`); },
    copyText: async () => { events.push('copy'); },
  };
  // Each case gets its own origin so the gate's availability cache stays per case.
  baseUrlCounter += 1;
  const baseUrl = `https://app${baseUrlCounter}.example.test`;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/authorize?')) return json(probeStatus, { error: probeError });
    if (url.endsWith('/token')) return json(200, TOKEN_BODY);
    return json(404, {});
  }) as typeof fetch;
  const session: CloudBrowserSignInSession = {
    config: { baseUrl, clientId: 'kordi-desktop', fetchImpl, driver, deviceRegistration: async () => { throw new Error('none'); } },
    complete: async (result) => { completed.push(result); },
  };
  return {
    session, events, completed, baseUrl,
    returnFromBrowser: (query: (state: string) => string) => returnFromBrowser(query(state)),
  };
}

async function withDom(run: (root: Root) => Promise<void>) {
  const installed = installDom();
  // Import after the DOM is installed so React attaches input change listeners.
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  assert.ok(match, `missing button ${name}; page: ${document.body.textContent}`);
  return match;
}

function text(): string {
  return document.body.textContent ?? '';
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const render = (root: Root, browserSignIn?: CloudBrowserSignInSession) => act(async () => {
  root.render(createElement(CloudSignInGate, { browserSignIn, onModeChange: () => {} }));
});

test('the welcome screen opens the browser and finishes from the loopback redirect', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    assert.equal(document.querySelector('input[type="email"]'), null, 'no in-app email form');
    assert.match(text(), /Welcome to Kordi/);
    button('Sign up');
    button('Trouble logging in? Copy link');

    await act(async () => { button('Log in').click(); });
    await settle();
    assert.deepEqual(fake.events, ['open /v1/cloud/auth/app/authorize']);
    assert.match(text(), /Continue in your browser/);
    assert.match(text(), new RegExp(`Log in on ${new URL(fake.baseUrl).host}, then come back here.`));

    await act(async () => { button('Open browser again').click(); });
    assert.equal(fake.events.filter((event) => event.startsWith('open')).length, 2);

    await act(async () => { fake.returnFromBrowser((state) => `code=kac_1&state=${state}`); });
    await settle();
    assert.equal(fake.completed.length, 1);
    assert.equal(fake.completed[0]?.account.accountId, ACCOUNT.accountId);
    assert.equal(fake.completed[0]?.refresh.refreshToken, 'kordi_rt_synthetic');
  });
});

test('a pasted code signs in and cancel returns to the welcome screen', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Trouble logging in? Copy link').click(); });
    await settle();
    assert.deepEqual(fake.events, ['copy']);
    assert.match(text(), /Link copied/);

    await act(async () => { button('Cancel').click(); });
    await settle();
    assert.ok(fake.events.includes('cancel'));
    assert.match(text(), /Welcome to Kordi/);
    assert.equal(document.querySelector('[role="alert"]'), null);

    await act(async () => { button('Log in').click(); });
    await settle();
    await act(async () => { button('Paste code').click(); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Paste code"]')!;
    await act(async () => { typeInto(input, ' kac_pasted '); });
    await act(async () => { button('Continue').click(); });
    await settle();
    assert.equal(fake.completed.length, 1);
  });
});

test('a browser refusal returns to the welcome screen with the error', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Sign up').click(); });
    await settle();
    await act(async () => { fake.returnFromBrowser((state) => `error=access_denied&state=${state}`); });
    await settle();
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Sign-in was canceled in the browser.');
    button('Log in');
    assert.equal(fake.completed.length, 0);
  });
});

test('older servers and runtimes without browser sign-in keep the in-app form', async () => {
  await withDom(async (root) => {
    await render(root, fakeSession({ probeStatus: 404, probeError: 'not_found' }).session);
    await settle();
    assert.ok(document.querySelector('input[type="email"]'), 'a server without the endpoint shows the form');

    await render(root, fakeSession({ probeStatus: 400, probeError: 'invalid_client' }).session);
    await settle();
    assert.ok(document.querySelector('input[type="email"]'), 'a server without this client shows the form');

    await render(root, undefined);
    await settle();
    assert.ok(document.querySelector('input[type="email"]'), 'no native shell shows the form');
  });
});
