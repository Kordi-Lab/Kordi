import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('desktop time formatting reuses Intl.DateTimeFormat instances', () => {
  const source = readFileSync(new URL('../src/lib/time.ts', import.meta.url), 'utf8');

  assert.match(source, /const desktopClockTimeFormatters = new Map/, 'clock time formatters should be cached by options');
  assert.match(source, /const desktopDateFormatters = new Map/, 'date formatters should be cached by time zone');
  assert.match(source, /const desktopDateTimeFormatters = new Map/, 'date-time formatters should be cached by time zone');
  assert.doesNotMatch(source, /return new Intl\.DateTimeFormat/, 'format helpers should not construct Intl formatters on every call');
});
