import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';

import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { cloudAccountsEqual } from '../src/features/cloud/cloudAccountState';
import { CloudAccountEmailRow, type CloudAccountEmailRowProps } from '../src/kordi-app/cloud/CloudAccountEmailRow';
import { cloudLoginErrorMessage } from '../src/kordi-app/cloud/cloudLoginMessages';
import { installDom } from './helpers/transcriptAttachmentDom';

const challenge = { verificationId: 'acct_email_1', expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 60 };

test('requesting an account email code sends an empty body with the session token', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(challenge);
  } });
  assert.deepEqual(await client.requestAccountEmailCode('session-token'), challenge);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/email/verification/code');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {});
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer session-token');

  for (const [code, status] of [
    ['email_missing', 400],
    ['email_already_verified', 409],
    ['email_delivery_unavailable', 503],
    ['rate_limited', 429],
  ] as const) {
    const failing = new CloudAuthClient({
      baseUrl: 'http://srv',
      fetchImpl: async () => Response.json({ errorCode: code, message: 'Server text.' }, { status }),
    });
    await assert.rejects(
      failing.requestAccountEmailCode('session-token'),
      (error: unknown) => error instanceof CloudAuthError && error.code === code && error.status === status,
    );
  }
});

test('verifying the account email sends the challenge fields and resolves on 204', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  } });
  assert.equal(
    await client.verifyAccountEmail('session-token', { verificationId: 'acct_email_1', verificationCode: '123456' }),
    undefined,
  );
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/email/verification');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { verificationId: 'acct_email_1', verificationCode: '123456' });
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer session-token');

  const failing = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => Response.json({ errorCode: 'invalid_verification_code', message: 'The email code is invalid or expired.' }, { status: 400 }),
  });
  await assert.rejects(
    failing.verifyAccountEmail('session-token', { verificationId: 'acct_email_1', verificationCode: '000000' }),
    (error: unknown) => error instanceof CloudAuthError && error.code === 'invalid_verification_code',
  );
});

test('account email errors have readable messages and verification state changes the account', () => {
  assert.equal(cloudLoginErrorMessage(new CloudAuthError('email_already_verified', '', 409), false), 'This email is already verified.');
  assert.equal(
    cloudLoginErrorMessage(new CloudAuthError('email_delivery_unavailable', '', 503), false),
    'Email verification is temporarily unavailable. Try again later.',
  );
  assert.equal(cloudLoginErrorMessage(new CloudAuthError('email_missing', '', 400), false), 'This account has no email address to verify.');
  const serverText = 'Email verification is temporarily unavailable. Try again later or continue with Google or GitHub.';
  for (const code of ['email_already_verified', 'email_delivery_unavailable', 'email_missing'] as const) {
    assert.equal(cloudLoginErrorMessage(new CloudAuthError(code, serverText, 400), false), serverText);
  }

  const account = {
    accountId: 'acct_1', displayName: 'Ada', primaryEmail: 'ada@example.com', primaryEmailVerified: false,
    avatarUrl: null, avatar: { entityType: 'human', entityId: 'acct_1', source: 'generated', style: 'x', seed: 's', rendererVersion: 1, uploadedAsset: null, version: 1, updatedAt: 't' },
    nodeId: null, passwordSet: true,
  } as unknown as Parameters<typeof cloudAccountsEqual>[0];
  assert.equal(cloudAccountsEqual(account, { ...account!, primaryEmailVerified: true }), false);
});

async function renderRow(props: Omit<CloudAccountEmailRowProps, 'verified'> & { verified: boolean | undefined }) {
  const installed = installDom();
  // Import after the DOM is installed so React attaches input change listeners.
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [verified, setVerified] = useState(props.verified);
    return createElement(CloudAccountEmailRow, {
      ...props,
      verified,
      onVerify: props.onVerify
        ? async (input) => { await props.onVerify!(input); setVerified(true); }
        : undefined,
      onAlreadyVerified: props.onAlreadyVerified
        ? async () => { await props.onAlreadyVerified!(); setVerified(true); }
        : undefined,
    });
  }
  await act(async () => root.render(createElement(Harness)));
  return {
    host,
    async fill(label: string, value: string) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      assert.ok(input);
      await act(async () => {
        Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
      });
    },
    button(text: string) {
      return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text) ?? null;
    },
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

test('email row is hidden when the server does not report verification state', async () => {
  const view = await renderRow({ email: 'ada@example.com', verified: undefined, onRequestCode: async () => challenge, onVerify: async () => {} });
  try {
    assert.equal(view.host.innerHTML, '');
  } finally {
    await view.cleanup();
  }
});

test('email row shows a verified address without a verify action', async () => {
  const view = await renderRow({ email: 'ada@example.com', verified: true, onRequestCode: async () => challenge, onVerify: async () => {} });
  try {
    assert.match(view.host.textContent!, /ada@example\.com/);
    assert.match(view.host.textContent!, /Verified/);
    assert.doesNotMatch(view.host.textContent!, /Not verified/);
    assert.equal(view.button('Verify email'), null);
  } finally {
    await view.cleanup();
  }
});

test('email row requests a code, reports a wrong code, cancels, and marks the email verified', async () => {
  let requests = 0;
  const attempts: Array<{ verificationId: string; verificationCode: string }> = [];
  const view = await renderRow({
    email: 'ada@example.com',
    verified: false,
    onRequestCode: async () => {
      requests += 1;
      return { ...challenge, verificationId: `acct_email_${requests}`, retryAfterSeconds: 0 };
    },
    onVerify: async (input) => {
      attempts.push(input);
      if (input.verificationCode !== '123456') {
        throw new CloudAuthError('invalid_verification_code', 'The email code is invalid or expired. Request a new code and try again.', 400);
      }
    },
  });
  try {
    assert.match(view.host.textContent!, /Not verified/);
    await act(async () => view.button('Verify email')!.click());
    assert.equal(requests, 1);
    assert.equal(view.button('Verify email'), null);
    assert.ok(view.host.querySelector('input[autocomplete="one-time-code"]'));
    assert.match(view.host.textContent!, /Enter the 6-digit code sent to ada@example\.com/);
    assert.equal(view.button('Resend code')?.disabled, false);
    assert.equal(view.button('Verify')!.disabled, true);

    await view.fill('Email verification code', '12ab');
    assert.equal(view.host.querySelector<HTMLInputElement>('input[aria-label="Email verification code"]')!.value, '12');

    await act(async () => view.button('Cancel')!.click());
    assert.equal(view.host.querySelector('input[autocomplete="one-time-code"]'), null);
    await act(async () => view.button('Verify email')!.click());
    assert.equal(requests, 2);

    await view.fill('Email verification code', '000000');
    await act(async () => view.button('Verify')!.click());
    assert.deepEqual(attempts, [{ verificationId: 'acct_email_2', verificationCode: '000000' }]);
    assert.match(view.host.textContent!, /invalid or expired/);
    assert.match(view.host.textContent!, /Not verified/);

    await view.fill('Email verification code', '123456');
    await act(async () => view.button('Verify')!.click());
    assert.deepEqual(attempts[1], { verificationId: 'acct_email_2', verificationCode: '123456' });
    assert.equal(view.host.querySelector('input[autocomplete="one-time-code"]'), null);
    assert.match(view.host.textContent!, /Verified/);
    assert.doesNotMatch(view.host.textContent!, /Not verified/);
    assert.match(view.host.querySelector('[role="status"]')!.textContent!, /Email verified\./);
  } finally {
    await view.cleanup();
  }
});

test('email row keeps the verify action disabled after cancel until the resend cooldown ends', async () => {
  let requests = 0;
  const view = await renderRow({
    email: 'ada@example.com',
    verified: false,
    onRequestCode: async () => { requests += 1; return challenge; },
    onVerify: async () => {},
  });
  try {
    await act(async () => view.button('Verify email')!.click());
    assert.equal(view.button('Resend in 60s')?.disabled, true);
    await act(async () => view.button('Cancel')!.click());
    assert.equal(view.button('Verify email'), null);
    const held = view.button('Verify email (60s)');
    assert.ok(held);
    assert.equal(held.disabled, true);
    await act(async () => held.click());
    assert.equal(requests, 1);
  } finally {
    await view.cleanup();
  }
});

test('email row refreshes the account at once when the server says the email is already verified', async () => {
  for (const stage of ['request', 'verify'] as const) {
    let refreshes = 0;
    const alreadyVerified = new CloudAuthError('email_already_verified', '', 409);
    const view = await renderRow({
      email: 'ada@example.com',
      verified: false,
      onRequestCode: async () => {
        if (stage === 'request') throw alreadyVerified;
        return { ...challenge, retryAfterSeconds: 0 };
      },
      onVerify: async () => { throw alreadyVerified; },
      onAlreadyVerified: async () => { refreshes += 1; },
    });
    try {
      await act(async () => view.button('Verify email')!.click());
      if (stage === 'verify') {
        await view.fill('Email verification code', '123456');
        await act(async () => view.button('Verify')!.click());
      }
      assert.equal(refreshes, 1, stage);
      assert.equal(view.host.querySelector('input[autocomplete="one-time-code"]'), null, stage);
      assert.match(view.host.textContent!, /Verified/, stage);
      assert.doesNotMatch(view.host.textContent!, /Not verified/, stage);
      assert.match(view.host.querySelector('[role="status"]')!.textContent!, /This email is already verified\./, stage);
      assert.equal(view.host.querySelector('.app-error-text'), null, stage);
    } finally {
      await view.cleanup();
    }
  }
});

test('email row shows the server delivery message and falls back to readable text', async () => {
  for (const [message, expected] of [
    ['Email verification is temporarily unavailable. Try again later or continue with Google or GitHub.', /continue with Google or GitHub/],
    ['', /Email verification is temporarily unavailable\. Try again later\./],
  ] as const) {
    const view = await renderRow({
      email: 'ada@example.com',
      verified: false,
      onRequestCode: async () => { throw new CloudAuthError('email_delivery_unavailable', message, 503); },
      onVerify: async () => {},
    });
    try {
      await act(async () => view.button('Verify email')!.click());
      assert.match(view.host.querySelector('.app-error-text')!.textContent!, expected);
      assert.equal(view.button('Verify email')?.disabled, false);
    } finally {
      await view.cleanup();
    }
  }
});
