import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserAppNextFromHref,
  browserOAuthErrorCode,
  browserSiteSignInUrl,
  safeBrowserAppNext,
} from '@web/auth/browserSiteSignIn';

const origin = 'https://app.kordi.test';
const invite = `kordi_gi_${'a'.repeat(43)}`;

test('a signed-out page goes to the site login and comes back to the same page', () => {
  assert.equal(browserSiteSignInUrl(`${origin}/app/contacts`), '/login?next=%2Fapp%2Fcontacts');
  assert.equal(browserSiteSignInUrl(`${origin}/app/`), '/login?next=%2Fapp%2F');
  assert.equal(browserSiteSignInUrl(`${origin}/app`), '/login?next=%2Fapp');
  assert.equal(browserSiteSignInUrl(`${origin}/app/chats`, { page: 'register' }), '/register?next=%2Fapp%2Fchats');
});

test('the return path keeps the welcome and invitation hand-offs but never a fragment', () => {
  assert.equal(browserAppNextFromHref(`${origin}/app/?welcome=1`), '/app/?welcome=1');
  assert.equal(browserAppNextFromHref(`${origin}/app/chats?groupInvite=${invite}`), `/app/chats?groupInvite=${invite}`);
  assert.equal(browserAppNextFromHref(`${origin}/app/chats#kordi_cloud_oauth=abc`), '/app/chats');
});

test('an unsafe or overlong return path falls back to the path or the app home', () => {
  assert.equal(browserAppNextFromHref(`${origin}/app/chats?q=${'x'.repeat(600)}`), '/app/chats');
  assert.equal(browserAppNextFromHref(`${origin}/app/${'x'.repeat(600)}`), '/app/');
  assert.equal(browserAppNextFromHref(`${origin}/app//evil.example`), '/app/');
  assert.equal(browserAppNextFromHref(`${origin}/elsewhere`), '/app/');
  assert.equal(browserAppNextFromHref('not a url'), '/app/');
});

test('only same-origin browser app paths are accepted', () => {
  for (const value of ['/app', '/app/', '/app/contacts', '/app/?welcome=1', `/app/chats?groupInvite=${invite}`, '/app/s/abc%20def']) {
    assert.equal(safeBrowserAppNext(value), value, value);
  }
  for (const value of [
    '', '//evil.example', '/appx', '/app\\x', '/app/\\evil', 'javascript:alert(1)', 'https://evil.example/app/',
    '/app//evil.example', '/app/x#y', '/app/x y', '/app/x?y z', '%2F%2Fevil.example', '/app/%2F%2Fevil.example',
    '/app/%5Cevil', '/app/../account', '/app/./x', '/account', `/app/${'x'.repeat(520)}`,
  ]) {
    assert.equal(safeBrowserAppNext(value), null, value);
  }
});

test('a sign-out lands on the site login without a return path', () => {
  assert.equal(browserSiteSignInUrl(`${origin}/app/contacts`, { signedOut: true }), '/login');
});

test('an OAuth error is passed on to the site login as its code alone', () => {
  assert.equal(browserOAuthErrorCode('#kordi_cloud_oauth_error=Nope&kordi_cloud_oauth_error_code=access_pending'), 'access_pending');
  assert.equal(browserOAuthErrorCode('#kordi_cloud_oauth_error=<b>free text</b>'), 'oauth_failed');
  assert.equal(browserOAuthErrorCode('#kordi_cloud_oauth_error_code=<script>'), 'oauth_failed');
  assert.equal(browserOAuthErrorCode('#section'), null);
  assert.equal(browserOAuthErrorCode(''), null);
  assert.equal(
    browserSiteSignInUrl(`${origin}/app/contacts`, { oauthErrorCode: 'access_pending' }),
    '/login?next=%2Fapp%2Fcontacts#kordi_cloud_oauth_error_code=access_pending',
  );
});
