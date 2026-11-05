import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = (name: string) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');

/** The declarations of the last rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...source.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'g'))].map(match => match[1]);
  assert.ok(blocks.length > 0, `missing rule ${selector}`);
  return blocks.at(-1)!;
}

test('the dark frosted welcome window has a dense dark surface', () => {
  const veil = rule(css('theme-auth-gate.css'), '.kordi-app.app-cloud-login-shell[data-frosted="true"] .app-cloud-login-page');
  const match = veil.match(/--app-cloud-login-page-bg:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  assert.ok(match, 'the dark veil is a single rgb color');
  const [, red, green, blue, alpha] = match.map(Number);
  assert.ok(Math.max(red, green, blue) <= 32, 'the veil is near black');
  // A faint veil leaves the macOS material showing as a washed-out mid grey.
  assert.ok(alpha >= 0.75, `the veil covers the material (alpha ${alpha})`);
});

test('dark sign-in buttons use a light ink fill, not the theme accent', () => {
  const signIn = css('theme-cloud-signin.css');
  const primary = rule(signIn, '.kordi-app.theme-dark .app-cloud-browser-signin .app-cloud-login-submit');
  assert.doesNotMatch(primary, /--app-button-primary|accent/);
  assert.match(primary, /background:\s*oklch\(0\.9\d/);
  assert.match(primary, /color:\s*oklch\(0\.[12]\d?\s/);
  const secondary = rule(signIn, '.kordi-app.theme-dark .app-cloud-browser-signin .app-cloud-welcome-secondary');
  assert.match(secondary, /background:\s*rgb\(255 255 255 \/ 0\.1/);
});
