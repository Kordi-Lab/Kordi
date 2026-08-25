import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KORDI_CHAT_THEME_STORAGE_KEY,
  KORDI_CHAT_THEMES,
  KORDI_THEME_MODE_STORAGE_KEY,
  readStoredChatTheme,
  readStoredThemeMode,
  resolveThemeMode,
  writeStoredChatTheme,
  writeStoredThemeMode,
} from '../src/app/themePreference';

type StorageStub = Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> };

function storage(initial: Record<string, string> = {}): StorageStub {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
}

test('theme preference defaults to auto for brand-new installs', () => {
  assert.equal(readStoredThemeMode(storage()), 'auto');
  assert.equal(readStoredThemeMode(undefined), 'auto');
});

test('theme preference reads only valid stored modes', () => {
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'light' })), 'light');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'dark' })), 'dark');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'auto' })), 'auto');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'system' })), 'auto');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: '{bad json' })), 'auto');
});

test('theme preference writes under a stable v1 key', () => {
  const target = storage();

  writeStoredThemeMode('dark', target);

  assert.equal(KORDI_THEME_MODE_STORAGE_KEY, 'kordi.themeMode.v1');
  assert.equal(target.values.get(KORDI_THEME_MODE_STORAGE_KEY), 'dark');
});

test('theme resolver follows system mode only when preference is auto', () => {
  assert.equal(resolveThemeMode('auto', 'light'), 'light');
  assert.equal(resolveThemeMode('auto', 'dark'), 'dark');
  assert.equal(resolveThemeMode('light', 'dark'), 'light');
  assert.equal(resolveThemeMode('dark', 'light'), 'dark');
});

test('chat theme preference accepts the four bundled themes and rejects unknown values', () => {
  assert.deepEqual(KORDI_CHAT_THEMES, ['quiet', 'midnight', 'sand', 'ocean']);
  for (const theme of KORDI_CHAT_THEMES) {
    assert.equal(readStoredChatTheme(storage({ [KORDI_CHAT_THEME_STORAGE_KEY]: theme })), theme);
  }
  assert.equal(readStoredChatTheme(storage()), 'quiet');
  assert.equal(readStoredChatTheme(storage({ [KORDI_CHAT_THEME_STORAGE_KEY]: 'custom' })), 'quiet');

  const target = storage();
  writeStoredChatTheme('ocean', target);
  assert.equal(target.values.get(KORDI_CHAT_THEME_STORAGE_KEY), 'ocean');
});
