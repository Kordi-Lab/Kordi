import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readDesktopSource = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const readRepositorySource = (relativePath: string) =>
  readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');

const faviconDataUrl = (source: string) => {
  const match = source.match(/const KORDI_FAVICON_DATA_URL: &str = "([^"]+)";/);
  assert.ok(match, 'generated browser pages should declare a Kordi favicon data URL');
  return match[1];
};

test('desktop entry point uses the canonical three-circle Kordi favicon', () => {
  const indexHtml = readDesktopSource('index.html');
  const favicon = readDesktopSource('public/favicon.svg');

  assert.match(indexHtml, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  assert.equal((favicon.match(/<circle /g) ?? []).length, 3);
  assert.match(favicon, /<circle cx="18" cy="10" r="9"/);
  assert.match(favicon, /<circle cx="11" cy="22" r="9"/);
  assert.match(favicon, /<circle cx="25" cy="22" r="9"/);
  assert.equal((favicon.match(/fill="#1a1714"/g) ?? []).length, 3);
});

test('self-contained OAuth pages embed the same Kordi favicon', () => {
  const desktopCallback = readDesktopSource('src-tauri/src/cloud_oauth_loopback.rs');
  const cliCallback = readRepositorySource('agent/crates/cli/src/oauth/callback_server.rs');

  assert.equal(faviconDataUrl(desktopCallback), faviconDataUrl(cliCallback));
  assert.match(faviconDataUrl(desktopCallback), /%3Ccircle cx='18' cy='10' r='9'/);
  assert.match(faviconDataUrl(desktopCallback), /fill='%231a1714'/);
  assert.doesNotMatch(faviconDataUrl(desktopCallback), /^https?:/);
});

test('hosted invitation pages reuse the homepage favicon asset', () => {
  const invitationPage = readRepositorySource(
    'bridges/cloud-server/src/auth/routes/app_invitation_handlers.rs',
  );

  assert.match(invitationPage, /const KORDI_FAVICON_URL: &str = "\/assets\/favicon\.png";/);
  assert.match(invitationPage, /<link rel="icon" type="image\/png" sizes="512x512" href="\{favicon_url\}">/);
  assert.match(invitationPage, /img-src 'self'/);
});
