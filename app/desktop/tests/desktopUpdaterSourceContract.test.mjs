import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('desktop update path contains no URL-driven native installer or destructive app replacement', () => {
  const rust = source('../src-tauri/src/lib.rs');
  const desktop = source('../src/lib/desktop.ts');
  const sidebar = source('../src/pages/WorkspaceSidebar.tsx');

  for (const text of [rust, desktop, sidebar]) {
    assert.doesNotMatch(text, /desktop_check_for_updates/);
    assert.doesNotMatch(text, /desktop_install_update/);
    assert.doesNotMatch(text, /install-kordi-update\.sh/);
    assert.doesNotMatch(text, /rm -rf ["']?\/Applications/);
  }
  assert.doesNotMatch(rust, /Update download URL must be http or https/);
  assert.doesNotMatch(desktop, /downloadUrl/);
  assert.doesNotMatch(sidebar, /downloadUrl/);
  assert.doesNotMatch(sidebar, /onInstallUpdate\?\(\{[^}]*url/i);
});

test('the real updater adapter delegates verification and installation to Tauri plugins', () => {
  const controller = source('../src/features/updates/desktopUpdater.ts');

  assert.match(controller, /@tauri-apps\/plugin-updater/);
  assert.match(controller, /downloadAndInstall/);
  assert.match(controller, /@tauri-apps\/plugin-process/);
  assert.match(controller, /relaunch/);
  assert.match(controller, /const KORDI_RELEASE_ORIGIN = 'https:\/\/coordinar\.io'/);
  assert.match(controller, /manualUpdateUrlForVersion\(update\.version\)/);
  assert.match(controller, /\/updates\/releases\/\$\{encoded\}\/Kordi_\$\{encoded\}_aarch64\.dmg/);
  assert.doesNotMatch(controller, /\/updates\/releases\/latest\/Kordi\.dmg/);
  assert.doesNotMatch(controller, /https?:\/\/\$\{/);
  const literalOrigins = [...controller.matchAll(/https?:\/\/[^/'"`\s]+/g)]
    .map((match) => match[0]);
  assert.deepEqual([...new Set(literalOrigins)], ['https://coordinar.io']);
  assert.doesNotMatch(controller, /http:\/\//);
});
