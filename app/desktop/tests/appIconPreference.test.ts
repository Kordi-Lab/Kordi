import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  DEFAULT_APP_ICON,
  KORDI_APP_ICONS,
  KORDI_APP_ICON_STORAGE_KEY,
  appIconPreviewUrl,
  readStoredAppIcon,
  writeStoredAppIcon,
} from '../src/app/appIconPreference';
import { APP_ICON_VARIANTS } from '../../../scripts/kordi-app-icons/icons.mjs';

const desktopFile = (relativePath: string) => new URL(`../${relativePath}`, import.meta.url);

test('app icon choices match the generated icon variants', () => {
  assert.deepEqual(
    KORDI_APP_ICONS.map((icon) => [icon.key, icon.label]),
    APP_ICON_VARIANTS.map((variant: { key: string; name: string }) => [variant.key, variant.name]),
  );
  assert.equal(DEFAULT_APP_ICON, 'white');
});

test('every app icon ships a picker preview and a Dock image', () => {
  for (const { key } of KORDI_APP_ICONS) {
    assert.equal(appIconPreviewUrl(key), `/app-icons/${key}.png`);
    assert.ok(existsSync(desktopFile(`public/app-icons/${key}.png`)), `missing preview for ${key}`);
    assert.ok(existsSync(desktopFile(`src-tauri/icons/app-icons/${key}.png`)), `missing Dock image for ${key}`);
  }
});

test('stored app icon falls back to the default for unknown values', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  assert.equal(readStoredAppIcon(storage), 'white');
  writeStoredAppIcon('frosted', storage);
  assert.equal(values.get(KORDI_APP_ICON_STORAGE_KEY), 'frosted');
  assert.equal(readStoredAppIcon(storage), 'frosted');
  values.set(KORDI_APP_ICON_STORAGE_KEY, 'disc');
  assert.equal(readStoredAppIcon(storage), 'white');
  assert.equal(readStoredAppIcon({ getItem: () => { throw new Error('blocked'); } }), 'white');
});

test('iOS, Rust, and the iOS build settings offer the same app icons', () => {
  const read = (relativePath: string) => readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');
  const keys = KORDI_APP_ICONS.map((icon) => icon.key);
  const swiftKeys = [...read('app/ios/Kordi/Features/Profile/AppIconSettings.swift').matchAll(/KordiAppIcon\(key: "([^"]+)"/g)]
    .map((match) => match[1]);
  const rustKeys = [...read('app/desktop/src-tauri/src/app_icon.rs').matchAll(/\(\s*"([^"]+)",\s*include_bytes!/g)]
    .map((match) => match[1]);
  const alternateNames = read('app/ios/project.yml').match(/ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES: (.+)/)?.[1]
    .trim().split(/\s+/);

  assert.deepEqual(swiftKeys, keys);
  assert.deepEqual(rustKeys, keys);
  assert.deepEqual(alternateNames, keys.filter((key) => key !== DEFAULT_APP_ICON).map((key) => `AppIcon-${key}`));
});
