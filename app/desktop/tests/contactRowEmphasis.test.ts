import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const transcriptSource = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

test('contact rows do not promote the active contact with a heavy selected banner', () => {
  const contactRowSource = transcriptSource.slice(
    transcriptSource.indexOf('export function ContactRow'),
    transcriptSource.indexOf('export function ContactRequestRow'),
  );

  assert.match(contactRowSource, /active \? 'app-contact-row-active app-list-item text-white' : 'app-contact-row app-list-item text-white'/);
  assert.doesNotMatch(contactRowSource, /active \? 'app-list-item-active text-white'/);

  const activeRule = cssRule(shellCss, '.app-contact-row-active');
  assert.match(activeRule, /background:\s*transparent;/);
  assert.match(activeRule, /box-shadow:\s*none;/);
  assert.match(activeRule, /border-color:\s*transparent;/);

  const lightRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-contact-row-active');
  assert.match(lightRule, /background:\s*transparent !important;/);
  assert.match(lightRule, /box-shadow:\s*none !important;/);
  assert.doesNotMatch(lightRule, /rgb\(247 247 247\)|rgb\(238 238 238\)|var\(--app-sidebar-selected-bg\)/);
});
