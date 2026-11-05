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

function fakeSession({
  probeStatus = 400, probeError = 'invalid_redirect_uri', tokenStatus = 200, openFails = false, deviceCodeStatus = 200,
} = {}) {
  const events: string[] = [];
  let probes = 0;
  let devicePolls = 0;
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
    openUrl: async (url) => {
      events.push(`open ${new URL(url).pathname}`);
      if (openFails) throw new Error('No browser');
    },
  };
  // Each case gets its own origin so the gate's availability cache stays per case.
  baseUrlCounter += 1;
  const baseUrl = `https://app${baseUrlCounter}.example.test`;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/authorize?')) {
      probes += 1;
      return json(probeStatus, { error: probeError });
    }
    if (url.endsWith('/device/code')) {
      events.push('device code');
      return deviceCodeStatus === 200
        ? json(200, { device_code: 'kordi_dc_synthetic', user_code: 'CDFG-HJKM', verification_uri: `${baseUrl}/device`, expires_in: 900, interval: 5 })
        : json(deviceCodeStatus, {});
    }
    if (url.endsWith('/device/token')) {
      devicePolls += 1;
      return devicePolls < 2 ? json(400, { error: 'authorization_pending' }) : json(200, TOKEN_BODY);
    }
    if (url.endsWith('/token')) return tokenStatus === 200 ? json(200, TOKEN_BODY) : json(tokenStatus, { error: 'invalid_grant' });
    return json(404, {});
  }) as typeof fetch;
  const session: CloudBrowserSignInSession = {
    config: {
      baseUrl, clientId: 'kordi-desktop', fetchImpl, driver,
      deviceRegistration: async () => { throw new Error('none'); },
      sleep: async () => {},
    },
    complete: async (result) => { completed.push(result); },
  };
  return {
    session, events, completed, baseUrl, probes: () => probes,
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

const render = (
  root: Root,
  browserSignIn?: CloudBrowserSignInSession,
  onBrowserSignInChange?: (active: boolean) => void,
) => act(async () => {
  root.render(createElement(CloudSignInGate, { browserSignIn, onModeChange: () => {}, onBrowserSignInChange }));
});

test('the welcome screen opens the browser and finishes from the loopback redirect', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    assert.equal(document.querySelector('input[type="email"]'), null, 'no in-app email form');
    assert.match(text(), /Welcome to Kordi/);
    button('Sign up');
    assert.doesNotMatch(text(), /Trouble logging in/);

    await act(async () => { button('Log in').click(); });
    await settle();
    assert.deepEqual(fake.events, ['open /v1/cloud/auth/app/authorize']);
    assert.match(text(), /Continue in your browser/);
    assert.equal(document.activeElement?.textContent, 'Continue in your browser', 'focus moves to the wait screen');
    assert.doesNotMatch(text(), /Log in on|come back here|Link copied/, 'the wait screen has no subtitle');

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
    await act(async () => { button('Log in').click(); });
    await settle();
    assert.deepEqual(fake.events, ['open /v1/cloud/auth/app/authorize']);

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

test('a refused pasted code is announced and described on the field', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ tokenStatus: 400 });
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    await act(async () => { button('Paste code').click(); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Paste code"]')!;
    assert.equal(input.getAttribute('aria-describedby'), null);
    await act(async () => { typeInto(input, 'kac_expired'); });
    await act(async () => { button('Continue').click(); });
    await settle();
    const describedBy = input.getAttribute('aria-describedby');
    assert.ok(describedBy);
    assert.match(document.getElementById(describedBy)?.textContent ?? '', /expired or was already used/);
    assert.equal(fake.completed.length, 0);
  });
});

test('an inconclusive availability check keeps browser sign-in and is asked again', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ probeStatus: 429, probeError: 'rate_limited' });
    await render(root, fake.session);
    await settle();
    assert.equal(document.querySelector('input[type="email"]'), null);
    assert.match(text(), /Welcome to Kordi/);
    const probes = fake.probes();
    await render(root, undefined);
    await settle();
    await render(root, fake.session);
    await settle();
    assert.ok(fake.probes() > probes, 'an unknown answer is not cached');
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

test('the gate reports whether browser sign-in or the in-app form is showing', async () => {
  await withDom(async (root) => {
    const reports: boolean[] = [];
    const report = (active: boolean) => { reports.push(active); };
    await render(root, fakeSession().session, report);
    await settle();
    assert.equal(reports.at(-1), true, 'browser sign-in keeps the compact window');

    await render(root, fakeSession({ probeStatus: 404, probeError: 'not_found' }).session, report);
    await settle();
    assert.ok(document.querySelector('input[type="email"]'));
    assert.equal(reports.at(-1), false, 'the in-app form takes its own window size');
  });
});

test('when the browser cannot open, a code signs this Mac in', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ openFails: true });
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    assert.match(text(), /Could not open your browser/);
    await act(async () => { button('Sign in with a code').click(); });
    await settle();
    assert.ok(fake.events.includes('device code'));
    assert.ok(fake.events.includes('cancel'), 'the browser attempt stops listening');
    assert.equal(fake.completed.length, 1, `page: ${text()}`);
    assert.equal(fake.completed[0]?.refresh.tokenEndpoint, `${fake.baseUrl}/v1/cloud/auth/app/token`);
  });
});

test('the code screen shows the code and the approval page', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ openFails: true });
    // Hold the poll so the code screen stays up.
    fake.session.config.sleep = () => new Promise(() => {});
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    await act(async () => { button('Sign in with a code').click(); });
    await settle();
    assert.match(text(), /Sign in with a code/);
    assert.match(text(), /CDFG-HJKM/);
    assert.match(text(), /app\d+\.example\.test\/device/);
    assert.match(text(), /Never share this code/);
    await act(async () => { button('Cancel').click(); });
    await settle();
    assert.match(text(), /Welcome to Kordi/);
  });
});

test('a server without device codes returns to browser sign-in', async () => {
  await withDom(async (root) => {
    const fake = fakeSession({ openFails: true, deviceCodeStatus: 404 });
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    await act(async () => { button('Sign in with a code').click(); });
    await settle();
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'Sign-in with a code is not available on this server.',
    );
    button('Log in');
  });
});

test('sign in with a code stays hidden while the browser opens', async () => {
  await withDom(async (root) => {
    const fake = fakeSession();
    await render(root, fake.session);
    await settle();
    await act(async () => { button('Log in').click(); });
    await settle();
    assert.doesNotMatch(text(), /Sign in with a code/);
  });
});
