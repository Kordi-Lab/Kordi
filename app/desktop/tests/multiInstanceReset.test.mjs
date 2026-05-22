import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tauriProfileArtifactPaths } from '../scripts/multi-instance/shared.mjs';

test('multi-instance reset removes per-profile Tauri WebKit and app storage artifacts', () => {
  const paths = tauriProfileArtifactPaths({ profile: 'User 1', homeDir: '/Users/example' });

  assert.deepEqual(paths, [
    '/Users/example/Library/Application Support/io.kordi.desktop.user-1',
    '/Users/example/Library/Caches/io.kordi.desktop.user-1',
    '/Users/example/Library/WebKit/io.kordi.desktop.user-1',
    '/Users/example/Library/HTTPStorages/io.kordi.desktop.user-1',
    '/Users/example/Library/Saved Application State/io.kordi.desktop.user-1.savedState',
    '/Users/example/Library/Preferences/io.kordi.desktop.user-1.plist',
    '/Users/example/Library/Cookies/io.kordi.desktop.user-1.binarycookies',
  ]);
});
