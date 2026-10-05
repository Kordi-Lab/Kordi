import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthError, type CloudAuthClient } from '../src/features/cloud/authClient';
import { parseCloudOAuthHashError } from '../src/features/cloud/cloudOAuthResult';
import { startCloudOAuthSignIn } from '../src/features/cloud/cloudOAuthSignIn';
import { cloudLoginErrorMessage } from '../src/kordi-app/cloud/cloudLoginMessages';

const EXISTING_ACCOUNT_MESSAGE =
  'A Kordi account already uses this email. Sign in with your email and password.';
const EXISTING_ACCOUNT_FRAGMENT = `#kordi_cloud_oauth_error=${encodeURIComponent(EXISTING_ACCOUNT_MESSAGE)}`
  + '&kordi_cloud_oauth_error_code=oauth_email_requires_sign_in';

test('OAuth callback errors keep the server message and stable code', () => {
  assert.deepEqual(parseCloudOAuthHashError(EXISTING_ACCOUNT_FRAGMENT), {
    code: 'oauth_email_requires_sign_in',
    message: EXISTING_ACCOUNT_MESSAGE,
  });
  assert.deepEqual(parseCloudOAuthHashError('#kordi_cloud_oauth_error=access_denied'), {
    code: null,
    message: 'access_denied',
  });
  assert.equal(parseCloudOAuthHashError('#kordi_cloud_oauth=e30'), null);
  assert.equal(parseCloudOAuthHashError(''), null);
});

test('desktop OAuth sign-in surfaces an existing-account refusal as actionable copy', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const commands: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          commands.push(command);
          switch (command) {
            case 'cloud_oauth_loopback_prepare':
              return { requestId: 'cloud_oauth_test', redirectUrl: 'http://127.0.0.1:4100/oauth/cloud_oauth_test' };
            case 'cloud_oauth_loopback_wait':
              return EXISTING_ACCOUNT_FRAGMENT;
            default:
              return null;
          }
        },
      },
    },
  });
  const authClient = {
    startOAuth: async () => ({ authUrl: 'https://accounts.example.test/authorize' }),
  } as unknown as CloudAuthClient;

  try {
    await assert.rejects(
      () => startCloudOAuthSignIn(authClient, 'google'),
      (caught: unknown) => {
        assert.ok(caught instanceof CloudAuthError);
        assert.equal(caught.code, 'oauth_email_requires_sign_in');
        assert.equal(cloudLoginErrorMessage(caught, false), EXISTING_ACCOUNT_MESSAGE);
        return true;
      },
    );
    assert.ok(commands.includes('cloud_oauth_loopback_cancel'), 'the loopback listener is released');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('existing-account refusals have fallback copy when the server sends no message', () => {
  const message = cloudLoginErrorMessage(
    new CloudAuthError('oauth_email_requires_sign_in', '', 0),
    false,
  );
  assert.match(message, /already uses this email/);
});
