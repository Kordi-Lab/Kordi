import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CloudOAuthProvider } from '../src/features/cloud/authClient';
import { isCloudOAuthProvider } from '../src/features/cloud/cloudAuthCapabilityTypes';
import { offeredCloudOAuthProviders } from '../src/features/cloud/cloudAuthReleasePolicy';
import { CloudBrowserSignInPage } from '../src/kordi-app/cloud/CloudBrowserSignInPage';
import { CloudLoginPage } from '../src/kordi-app/cloud/CloudLoginPage';
import { enabledSocialLoginProviders } from '../src/kordi-app/cloud/cloudLoginSocialProviders';

const communityEnv = { DEV: true, VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081', VITE_KORDI_DEV_PROFILE: 'community' };

test('apple is a known sign-in provider', () => {
  assert.equal(isCloudOAuthProvider('apple'), true);
  assert.equal(isCloudOAuthProvider('x'), false);
});

test('packaged apps keep Google and GitHub and add Apple only when the server lists it', () => {
  assert.deepEqual(offeredCloudOAuthProviders([], { DEV: false }), ['google', 'github']);
  assert.deepEqual(offeredCloudOAuthProviders(['google'], { DEV: false }), ['google', 'github']);
  assert.deepEqual(offeredCloudOAuthProviders(['google', 'github', 'apple'], { DEV: false }), ['google', 'github', 'apple']);
  assert.deepEqual(offeredCloudOAuthProviders(['apple', 'x'], { DEV: false }), ['google', 'github', 'apple']);
});

test('development follows the server list, Apple included', () => {
  assert.deepEqual(offeredCloudOAuthProviders(['github', 'apple', 'x'], communityEnv), ['github', 'apple']);
  assert.deepEqual(offeredCloudOAuthProviders([], communityEnv), []);
});

test('the login page offers Apple only when the server lists it', () => {
  assert.deepEqual(enabledSocialLoginProviders(false, ['google', 'github', 'apple']), []);
  assert.deepEqual(enabledSocialLoginProviders(true, ['google', 'github']), ['google', 'github']);
  assert.deepEqual(enabledSocialLoginProviders(true, []), ['google', 'github']);
  assert.deepEqual(enabledSocialLoginProviders(true, ['apple']), ['google', 'github', 'apple']);

  const without = renderToStaticMarkup(createElement(CloudLoginPage, { onSocialSignIn: async () => {}, oauthProviders: ['google', 'github'] }));
  assert.doesNotMatch(without, /data-provider="apple"/);
  const withApple = renderToStaticMarkup(createElement(CloudLoginPage, { onSocialSignIn: async () => {}, oauthProviders: ['google', 'github', 'apple'] }));
  assert.match(withApple, /aria-label="Sign in with Apple"/);
  assert.match(withApple, /data-provider="apple" data-provider-available="true"/);
  // Order: Google, GitHub, Apple.
  assert.ok(withApple.indexOf('data-provider="google"') < withApple.indexOf('data-provider="apple"'));
});

test('sign-in screens carry the Terms and Privacy Policy line', () => {
  const form = renderToStaticMarkup(createElement(CloudLoginPage, {}));
  assert.match(form, /By continuing you agree to the/);
  assert.match(form, /href="https:\/\/kordi\.ai\/terms"[^>]*>Terms<\/a>/);
  assert.match(form, /href="https:\/\/kordi\.ai\/privacy"[^>]*>Privacy Policy<\/a>/);
  const welcome = renderToStaticMarkup(createElement(CloudBrowserSignInPage, {
    signIn: {
      phase: 'welcome', error: null, codeError: null, submittingCode: false,
      start: async () => {}, reopenBrowser: () => {}, cancel: () => {}, submitCode: async () => {},
    },
  }));
  assert.match(welcome, /class="app-cloud-welcome-legal"/);
  assert.match(welcome, /Privacy Policy/);
});

test('clicking Apple starts the same browser sign-in as the other providers', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://127.0.0.1/' });
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  const started: CloudOAuthProvider[] = [];
  try {
    await act(async () => root.render(createElement(CloudLoginPage, {
      onModeChange: () => {},
      oauthProviders: ['google', 'github', 'apple'],
      onSocialSignIn: async (provider: CloudOAuthProvider) => { started.push(provider); },
    })));
    const apple = document.querySelector<HTMLButtonElement>('[data-provider="apple"]')!;
    await act(async () => { apple.click(); });
    assert.deepEqual(started, ['apple']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
