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

test('desktop entry point uses the generated Kordi bird favicon', async () => {
  const { inlineMarkSvg, inlineMarkDataUrl, AMBER, INK } = await import('../../../scripts/kordi-app-icons/icons.mjs');
  const indexHtml = readDesktopSource('index.html');
  const favicon = readDesktopSource('public/favicon.svg');

  assert.match(indexHtml, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  assert.equal(favicon.trim(), inlineMarkSvg({ color: INK, beak: AMBER }).replace(" aria-hidden='true'", ''));
  assert.doesNotMatch(favicon, /<circle cx="18" cy="10"/);
  assert.ok(inlineMarkDataUrl().startsWith('data:image/svg+xml,%3Csvg'));
});

test('self-contained OAuth pages embed the same Kordi bird favicon and mark', async () => {
  const { inlineMarkDataUrl } = await import('../../../scripts/kordi-app-icons/icons.mjs');
  const desktopCallback = readDesktopSource('src-tauri/src/cloud_oauth_loopback.rs');
  const cliCallback = readRepositorySource('agent/crates/cli/src/oauth/callback_server.rs');
  const capturePage = readDesktopSource('src-tauri/src/auth/login_callback_capture/callback_page.html');

  assert.equal(faviconDataUrl(desktopCallback), inlineMarkDataUrl());
  assert.equal(faviconDataUrl(cliCallback), inlineMarkDataUrl());
  assert.ok(capturePage.includes(`href="${inlineMarkDataUrl()}"`));
  for (const page of [desktopCallback, cliCallback, capturePage]) {
    assert.match(page, /mask='url\(#kordi-bird-cut\)'/);
    assert.doesNotMatch(page, /circle cx=.18. cy=.10/);
  }
});

test('hosted invitation pages reuse the homepage favicon asset', () => {
  const invitationPage = readRepositorySource(
    'bridges/cloud-server/src/auth/routes/app_invitation_handlers.rs',
  );

  assert.match(invitationPage, /const KORDI_FAVICON_URL: &str = "\/assets\/favicon\.png";/);
  assert.match(invitationPage, /<link rel="icon" type="image\/png" sizes="512x512" href="\{favicon_url\}">/);
  assert.match(invitationPage, /img-src 'self'/);
});
