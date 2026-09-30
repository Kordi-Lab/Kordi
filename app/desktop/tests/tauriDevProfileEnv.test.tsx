import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildBeforeDevCommand,
  desktopDevCapabilities,
  desktopDevCsp,
  resolveDesktopDevUrl,
  resolveDesktopPreviewIcons,
} from '../scripts/tauri-dev-env.mjs';

const appShellFrameSource = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
const defaultCapability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));

test('named desktop preview permits only its configured API origin', () => {
  const [capability] = desktopDevCapabilities(defaultCapability, 'http://127.0.0.1:17642');
  const httpPermission = capability.permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default');
  assert.ok(httpPermission);
  assert.deepEqual(httpPermission.allow, [{ url: 'http://127.0.0.1:17642' }]);
  assert.ok(!defaultCapability.permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default').allow.some((scope: { url: string }) => scope.url === 'http://127.0.0.1:17642'));

  const [remoteCapability] = desktopDevCapabilities(defaultCapability, 'https://test.example');
  const remotePermission = remoteCapability.permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default');
  assert.deepEqual(remotePermission.allow, [{ url: 'https://test.example' }]);
});

test('named desktop preview keeps the main-window-only capability', () => {
  const mainWindowCapability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/main-window.json', import.meta.url), 'utf8'));
  const capabilities = desktopDevCapabilities([defaultCapability, mainWindowCapability], 'http://127.0.0.1:17642');

  assert.deepEqual(capabilities.map((capability: { identifier: string }) => capability.identifier), ['default', 'main-window']);
  assert.deepEqual(capabilities[1], mainWindowCapability);
  const httpPermission = capabilities[0].permissions.find((permission: { identifier?: string }) => permission.identifier === 'http:default');
  assert.deepEqual(httpPermission.allow, [{ url: 'http://127.0.0.1:17642' }]);
  assert.throws(() => desktopDevCapabilities([mainWindowCapability], 'http://127.0.0.1:17642'), /HTTP permission/);
});

test('named desktop preview CSP swaps the product API for its own API origin', () => {
  const baseConfig = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const baseCsp = baseConfig.app.security.csp;
  const csp = desktopDevCsp(baseCsp, 'http://127.0.0.1:17642');

  assert.ok(csp['connect-src'].includes('http://127.0.0.1:17642'));
  assert.ok(csp['connect-src'].includes('ws://127.0.0.1:17642'));
  assert.ok(csp['img-src'].includes('http://127.0.0.1:17642'));
  assert.ok(csp['media-src'].includes('http://127.0.0.1:17642'));
  assert.doesNotMatch(JSON.stringify(csp), /kordi\.ai/, 'isolated profiles must not allow the product API');
  assert.deepEqual(csp['script-src'], baseCsp['script-src']);
  assert.ok(!baseCsp['connect-src'].includes('http://127.0.0.1:17642'), 'the packaged policy is not modified');
  assert.ok(baseCsp['connect-src'].includes('https://kordi.ai'), 'the packaged policy is not modified');

  const remote = desktopDevCsp(baseCsp, 'https://test.example');
  assert.ok(remote['connect-src'].includes('https://test.example'));
  assert.ok(remote['connect-src'].includes('wss://test.example'));

  const operator = desktopDevCsp(baseCsp, 'https://kordi.ai');
  assert.ok(operator['connect-src'].includes('https://kordi.ai'));
  assert.ok(operator['connect-src'].includes('wss://kordi.ai'));
  assert.throws(() => desktopDevCsp(baseCsp, 'file:///tmp'), /HTTP\(S\)/);
  assert.throws(() => desktopDevCsp("default-src 'self'", 'http://127.0.0.1:1'), /directive map/);
});

test('native startup preserves the title selected by a named Tauri profile', () => {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /set_title\("Kordi"\)/);
});

test('buildBeforeDevCommand does not forward removed edition env into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1492,
    env: {
      KORDI_EDITION: 'local',
      VITE_KORDI_EDITION: 'local',
      VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
    },
  });

  assert.match(command, /^VITE_KORDI_WINDOW_TITLE='Kordi Cloud' /);
  assert.doesNotMatch(command, /VITE_KORDI_EDITION|KORDI_EDITION/);
  assert.match(command, /npm run dev:web -- --host 127\.0\.0\.1 --port 1492 --strictPort$/);
});

test('buildBeforeDevCommand forwards explicit Cloud API base into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1482,
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081' },
  });

  assert.match(command, / VITE_KORDI_CLOUD_API_BASE='http:\/\/127\.0\.0\.1:17081' /);
  assert.match(command, / VITE_KORDI_DEV_PROFILE='community' /);
});

test('buildBeforeDevCommand fails closed without a debug server origin', () => {
  assert.throws(
    () => buildBeforeDevCommand({
      title: 'Kordi',
      host: '127.0.0.1',
      port: 1420,
      env: {},
    }),
    /VITE_KORDI_CLOUD_API_BASE is required for development/i,
  );
});

test('buildBeforeDevCommand rejects the production origin', () => {
  for (const productionOrigin of [
    'https://kordi.ai',
    'http://kordi.ai',
    'https://kordi.ai./',
  ]) {
    assert.throws(
      () => buildBeforeDevCommand({
        title: 'Kordi',
        host: '127.0.0.1',
        port: 1420,
        env: { VITE_KORDI_CLOUD_API_BASE: productionOrigin },
      }),
      /production Cloud API is blocked in development/i,
    );
  }
});

test('buildBeforeDevCommand permits production only for acknowledged operator runs', () => {
  const base = {
    VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai',
    VITE_KORDI_DEV_PROFILE: 'operator',
  };
  assert.throws(
    () => buildBeforeDevCommand({
      title: 'Kordi Operator',
      host: '127.0.0.1',
      port: 1420,
      env: base,
    }),
    /blocked in development/i,
  );

  const command = buildBeforeDevCommand({
    title: 'Kordi Operator',
    host: '127.0.0.1',
    port: 1420,
    env: {
      ...base,
      VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
    },
  });
  assert.match(command, /VITE_KORDI_DEV_PROFILE='operator'/);
  assert.match(command, /VITE_KORDI_PRODUCTION_DEBUG_ACK='1'/);
});

test('desktop preview icons visibly distinguish development from product', () => {
  assert.deepEqual(
    resolveDesktopPreviewIcons({ VITE_KORDI_DEV_PROFILE: 'community' }),
    ['icons/icon-dev.png', 'icons/icon-dev.icns'],
  );
  assert.deepEqual(
    resolveDesktopPreviewIcons({ VITE_KORDI_DEV_PROFILE: 'operator' }),
    ['icons/icon.png', 'icons/icon.icns'],
  );
});

test('named profiles may open one local development preview entry', () => {
  assert.equal(resolveDesktopDevUrl({
    host: '127.0.0.1',
    port: 14371,
    path: '/tests/visual/groupMentionPreview.html',
  }), 'http://127.0.0.1:14371/tests/visual/groupMentionPreview.html');
  assert.throws(
    () => resolveDesktopDevUrl({ host: '127.0.0.1', port: 14371, path: '//example.com' }),
    /local absolute URL path/i,
  );
});

test('named development profiles render a visible in-window instance label', () => {
  assert.match(appShellFrameSource, /if \(!import\.meta\.env\.DEV\) return null;/);
  assert.match(appShellFrameSource, /VITE_KORDI_WINDOW_TITLE/);
  assert.match(appShellFrameSource, /Preview · \{instanceLabel\}/);
  assert.match(appShellFrameSource, /aria-label=\{`Preview instance: \$\{instanceLabel\}`\}/);
});

test('production frontend preview builds before serving and preserves operator authorization', () => {
  const env = { VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai', VITE_KORDI_DEV_PROFILE: 'operator', VITE_KORDI_PRODUCTION_DEBUG_ACK: '1' };
  const command = buildBeforeDevCommand({ title: 'Memory test', host: '127.0.0.1', port: 62359, frontendMode: 'production', env });
  assert.match(command, /npm run build &&/);
  assert.match(command, /npm run preview -- --host '127\.0\.0\.1' --port 62359 --strictPort/);
  assert.doesNotMatch(command, /dev:web/);
  assert.equal(command.split("VITE_KORDI_DEV_PROFILE='operator'").length - 1, 2);
  assert.throws(() => buildBeforeDevCommand({ title: 'Test', host: '127.0.0.1', port: 62359, frontendMode: 'production', env: { ...env, VITE_KORDI_PRODUCTION_DEBUG_ACK: '' } }));
  assert.throws(() => buildBeforeDevCommand({ title: 'Test', host: '127.0.0.1', port: 62359, frontendMode: 'invalid', env }));
});
