import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/app/useKordiLocalUiState.ts', import.meta.url), 'utf8');

test('local UI state initializes theme synchronously from persisted preference unless URL preview overrides it', () => {
  assert.match(source, /useState<ThemeMode>\(\(\) => previewState\?\.themeMode \?\? readStoredThemeMode\(\)\)/);
  assert.doesNotMatch(source, /useState<ThemeMode>\('dark'\)/);
});

test('local UI state persists explicit theme changes through the exposed setter', () => {
  assert.match(source, /writeStoredThemeMode\(nextThemeMode\)/);
  assert.match(source, /const setThemeMode: Dispatch<SetStateAction<ThemeMode>> = useCallback/);
});

test('local UI state resolves auto theme through live system mode', () => {
  assert.match(source, /resolveThemeMode\(themeMode, systemThemeMode\)/);
  assert.match(source, /mediaQuery\.addEventListener\('change', updateSystemThemeMode\)/);
});
