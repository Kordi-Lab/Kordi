import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readStyle = (name: string) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');

const pinCss = readStyle('pinned-message-stack.css');
const themeCss = readStyle('theme-tokens.css');

function listRules() {
  return pinCss.split('\n').filter((line) => line.startsWith('.app-pin-list-'));
}

test('pinned message list dialog paints an opaque transient surface', () => {
  const dialog = listRules().find((line) => line.startsWith('.app-pin-list-dialog {'));
  assert.ok(dialog, 'Missing .app-pin-list-dialog rule');
  assert.match(dialog, /background:\s*var\(--app-transient-surface-fallback\);\s*background:\s*var\(--app-transient-surface-bg\);/);
  assert.match(dialog, /color:\s*var\(--app-transient-text\)/);
  assert.match(dialog, /border:\s*1px solid var\(--app-transient-border\)/);
  assert.match(dialog, /box-shadow:\s*var\(--app-transient-shadow\)/);
});

test('pinned message list only uses tokens the app theme defines', () => {
  const used = new Set<string>();
  for (const line of listRules()) {
    for (const match of line.matchAll(/var\((--[\w-]+)/g)) used.add(match[1]);
  }
  used.delete('--pin-accent');
  assert.ok(used.size > 0);
  const lightTheme = themeCss.slice(themeCss.indexOf('body.theme-light, .kordi-app.theme-light, .app-transient-theme-light'));
  for (const token of used) {
    const definition = new RegExp(`${token}\\s*:`);
    assert.match(themeCss, definition, `${token} is not defined in theme-tokens.css`);
    if (token.startsWith('--app-transient-')) {
      assert.match(lightTheme, definition, `${token} has no light theme value`);
    }
  }
});
