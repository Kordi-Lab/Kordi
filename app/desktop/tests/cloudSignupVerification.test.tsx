import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';

import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { CloudLoginPage, type CloudLoginPageProps } from '../src/kordi-app/cloud/CloudLoginPage';
import { installDom } from './helpers/transcriptAttachmentDom';

test('requesting an email code sends only the email and preserves verification errors', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const challenge = { verificationId: 'email_test', expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 60 };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json(challenge);
  } });
  assert.deepEqual(await client.requestSignupCode('owner@example.com'), challenge);
  assert.deepEqual(calls, [{ url: 'http://srv/v1/cloud/auth/signup/code', body: { email: 'owner@example.com' } }]);
  for (const code of ['email_verification_required', 'invalid_verification_code', 'email_delivery_unavailable'] as const) {
    const failing = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async () => Response.json({ errorCode: code, message: 'Try again.' }, { status: 400 }) });
    await assert.rejects(failing.requestSignupCode('owner@example.com'), (error: unknown) => error instanceof CloudAuthError && error.code === code);
  }
});

test('signup waits for an inbox code, retries wrong codes, and clears proof when email changes', async () => {
  const installed = installDom();
  // Import after the DOM is installed so React attaches input change listeners.
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const sent: string[] = [];
  const registrations: Array<Parameters<NonNullable<CloudLoginPageProps['onSignUp']>>[0]> = [];
  try {
    await act(async () => root.render(createElement(CloudLoginPage, {
      initialMode: 'signup', onModeChange: () => {},
      onRequestSignupCode: async (email) => {
        sent.push(email);
        return { verificationId: `email_${sent.length}`, expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 60 };
      },
      onSignUp: async (input) => {
        registrations.push(input);
        if (input.verificationCode === '000000') throw new CloudAuthError('invalid_verification_code', 'The email code is invalid or expired.', 400);
      },
    })));
    async function fill(label: string, value: string) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      assert.ok(input);
      await act(async () => {
        Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
      });
    }
    async function submit() {
      const button = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      assert.equal(button.disabled, false);
      await act(async () => button.click());
    }
    await fill('Email', 'owner@example.com');
    await fill('Password', 'correct horse');
    await fill('Confirm Password', 'correct horse');
    await submit();
    assert.deepEqual(sent, ['owner@example.com']);
    assert.equal(registrations.length, 0);
    assert.ok(host.querySelector('input[autocomplete="one-time-code"]'));
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    assert.equal(Array.from(host.querySelectorAll('button')).find(button => button.textContent?.startsWith('Resend in'))?.disabled, true);
    await fill('Email verification code', '000000');
    await submit();
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /invalid or expired/);
    await fill('Email verification code', '123456');
    await submit();
    assert.equal(registrations[1].verificationId, 'email_1');
    assert.equal(registrations[1].verificationCode, '123456');
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Change email')!.click());
    assert.equal(host.querySelector('input[autocomplete="one-time-code"]'), null);
    await fill('Email', 'other@example.com');
    await submit();
    assert.deepEqual(sent, ['owner@example.com', 'other@example.com']);
    assert.equal(host.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!.value, '');
    assert.equal(registrations.length, 2);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
