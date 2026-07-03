import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

test('light outgoing human bubble is soft blue and cannot fall back to black or warm yellow', () => {
  const css = readDesktopShellCss();
  const rule = cssRule(css, '.bridge-app.theme-light .app-chat-bubble-user');

  assert.match(rule, /--app-message-bubble-fill:\s*rgb\(216 236 255\);/);
  assert.match(rule, /--app-message-bubble-stroke:\s*rgb\(183 220 255\);/);
  assert.match(rule, /--app-message-mention:\s*rgb\(29 78 216\);/);
  assert.match(rule, /--app-message-meta:\s*rgba\(18, 48, 77, 0\.62\);/);
  assert.match(rule, /color:\s*rgb\(18 48 77\);/);
  assert.doesNotMatch(rule, /rgb\(17 17 17\)|255 255 255|245 241|255 251 235|251,\s*191,\s*36|oklch\([^)]*70|yellow|amber/i);
});

test('compact reply indicator is inline icon plus count so it does not expand message spacing', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcriptReplyAttribution.tsx', import.meta.url), 'utf8');
  const transcriptSource = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function RequestReplyLine');
  const block = source.slice(start);

  assert.match(block, /app-message-reply-line[^']*inline-flex[^']*gap-\[3px\][^']*px-0[^']*text-\[9\.5px\][^']*leading-none/);
  assert.match(block, /app-message-reply-line-icon h-2\.5 w-2\.5/);
  assert.match(block, /app-message-reply-count/);
  assert.doesNotMatch(block, /<span>\{text\}<\/span>|gap-1\.5|px-1|text-\[10px\]|leading-4|h-3 w-3/);
  assert.match(transcriptSource, /<RequestReplyLine summary=\{msg\.replySummary\} own=\{isOwnHumanMessage\} inline onNavigateToMessage=\{onNavigateToMessage\} \/>/);

  const css = readDesktopShellCss();
  const rule = cssRule(css, '.app-message-reply-line');
  const iconRule = cssRule(css, '.app-message-reply-line-icon');
  const countRule = cssRule(css, '.app-message-reply-count');
  const lightIconRule = cssRule(css, '.bridge-app.theme-light .app-message-reply-line-icon');
  const darkIconRule = cssRule(css, '.bridge-app.theme-dark .app-message-reply-line-icon');
  const lightCountRule = cssRule(css, '.bridge-app.theme-light .app-message-reply-count');
  const darkCountRule = cssRule(css, '.bridge-app.theme-dark .app-message-reply-count');
  assert.match(rule, /gap:\s*3px;/);
  assert.match(rule, /min-height:\s*14px;/);
  assert.match(rule, /line-height:\s*12px;/);
  assert.match(iconRule, /stroke-width:\s*2\.4;/);
  assert.match(countRule, /font-weight:\s*700;/);
  assert.match(lightIconRule, /color:\s*rgb\(37 99 235\);/);
  assert.match(darkIconRule, /color:\s*rgb\(147 197 253\);/);
  assert.match(lightCountRule, /color:\s*rgb\(37 99 235\);/);
  assert.match(darkCountRule, /color:\s*rgb\(147 197 253\);/);
});

test('portaled mention menu resolves light theme before first paint', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function ComposerMentionMenu');
  const end = source.indexOf('export function composerThinkingLabel', start);
  const block = source.slice(start, end);

  assert.match(source, /function initialComposerMentionMenuThemeClass/);
  assert.match(block, /useState\(initialComposerMentionMenuThemeClass\)/);
  assert.match(block, /document\.querySelector\('\.bridge-app\.theme-light'\)/);
  assert.doesNotMatch(block, /useState\(''\)/);

  const css = readDesktopShellCss();
  const lightRule = cssRule(css, '.app-composer-mention-menu-light');
  assert.match(lightRule, /color-scheme:\s*light;/);
  assert.match(lightRule, /transition:\s*none;/);
});
