import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KORDI_CHAT_THEME_LEGACY_STORAGE_KEY,
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

test('chat theme preference accepts the five bundled themes and falls back to Classic', () => {
  assert.equal(KORDI_CHAT_THEME_STORAGE_KEY, 'kordi.chatTheme.v2');
  assert.equal(KORDI_CHAT_THEME_LEGACY_STORAGE_KEY, 'kordi.chatTheme.v1');
  assert.deepEqual(KORDI_CHAT_THEMES, ['classic', 'quiet', 'midnight', 'sand', 'ocean']);
  for (const theme of KORDI_CHAT_THEMES) {
    assert.equal(readStoredChatTheme(storage({ [KORDI_CHAT_THEME_STORAGE_KEY]: theme })), theme);
  }
  assert.equal(readStoredChatTheme(storage()), 'classic');
  assert.equal(readStoredChatTheme(storage({ [KORDI_CHAT_THEME_STORAGE_KEY]: 'custom' })), 'classic');

  const target = storage();
  writeStoredChatTheme('ocean', target);
  assert.equal(target.values.get(KORDI_CHAT_THEME_STORAGE_KEY), 'ocean');
});

test('chat theme migrates the old implicit Quiet default to Classic once', () => {
  const target = storage({ [KORDI_CHAT_THEME_LEGACY_STORAGE_KEY]: 'quiet' });
  assert.equal(readStoredChatTheme(target), 'classic');
  assert.equal(target.values.get(KORDI_CHAT_THEME_STORAGE_KEY), 'classic');
  assert.equal(target.values.get(KORDI_CHAT_THEME_LEGACY_STORAGE_KEY), 'quiet');

  writeStoredChatTheme('quiet', target);
  assert.equal(readStoredChatTheme(target), 'quiet');
});

test('chat theme carries other legacy choices over unchanged', () => {
  for (const theme of ['classic', 'midnight', 'sand', 'ocean'] as const) {
    const target = storage({ [KORDI_CHAT_THEME_LEGACY_STORAGE_KEY]: theme });
    assert.equal(readStoredChatTheme(target), theme);
    assert.equal(target.values.get(KORDI_CHAT_THEME_STORAGE_KEY), theme);
  }
  const invalid = storage({ [KORDI_CHAT_THEME_LEGACY_STORAGE_KEY]: 'custom' });
  assert.equal(readStoredChatTheme(invalid), 'classic');
  assert.equal(invalid.values.get(KORDI_CHAT_THEME_STORAGE_KEY), 'classic');
});

test('chat theme v2 value wins over the legacy key', () => {
  const target = storage({
    [KORDI_CHAT_THEME_STORAGE_KEY]: 'quiet',
    [KORDI_CHAT_THEME_LEGACY_STORAGE_KEY]: 'ocean',
  });
  assert.equal(readStoredChatTheme(target), 'quiet');
  assert.equal(target.values.get(KORDI_CHAT_THEME_STORAGE_KEY), 'quiet');
});

test('chat theme falls back to Classic when both keys are absent or v2 is invalid', () => {
  const empty = storage();
  assert.equal(readStoredChatTheme(empty), 'classic');
  assert.equal(empty.values.get(KORDI_CHAT_THEME_STORAGE_KEY), 'classic');
  assert.equal(readStoredChatTheme(storage({
    [KORDI_CHAT_THEME_STORAGE_KEY]: 'custom',
    [KORDI_CHAT_THEME_LEGACY_STORAGE_KEY]: 'ocean',
  })), 'classic');
  assert.equal(readStoredChatTheme({ getItem: () => null }), 'classic');
});
