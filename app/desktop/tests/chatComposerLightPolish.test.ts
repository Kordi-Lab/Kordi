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

test('light outgoing human bubble uses the selected chat-theme tokens with no visible outline', () => {
  const css = readDesktopShellCss();
  const tokens = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const rule = cssRule(css, '.kordi-app.theme-light .app-chat-bubble-user');

  assert.match(rule, /--app-message-bubble-fill:\s*var\(--app-chat-bubble-user-bg\);/);
  assert.match(rule, /--app-message-bubble-stroke:\s*transparent;/);
  assert.match(rule, /--app-message-mention:\s*var\(--app-chat-mention-own\);/);
  assert.match(rule, /--app-message-meta:\s*var\(--app-chat-meta-own\);/);
  assert.match(rule, /color:\s*var\(--app-chat-bubble-user-text\);/);
  assert.match(tokens, /--app-chat-bubble-user-bg:\s*#E2EBF5;/);
  assert.match(tokens, /--app-chat-bubble-user-text:\s*#1F3145;/);
});

test('chat wallpaper spans the transcript and composer gutter as one surface', () => {
  const mainWorkspace = readFileSync(
    new URL('../src/pages/chatsPage.mainWorkspace.tsx', import.meta.url),
    'utf8',
  );
  const companionPane = readFileSync(
    new URL('../src/pages/chatsPage.companionPane.tsx', import.meta.url),
    'utf8',
  );
  const css = readDesktopShellCss();

  assert.match(
    mainWorkspace,
    /id="chat-main-messages-panel"[^>]*className="app-chat-theme-surface/s,
  );
  assert.match(
    companionPane,
    /id="chat-companion-messages-panel"[^>]*className="app-chat-theme-surface/s,
  );
  assert.match(
    cssRule(css, '.app-chat-theme-surface'),
    /background:\s*var\(--app-chat-wallpaper\);/,
  );
  assert.match(cssRule(css, '.app-chat-canvas'), /background:\s*transparent;/);
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
  const lightIconRule = cssRule(css, '.kordi-app.theme-light .app-message-reply-line-icon');
  const darkIconRule = cssRule(css, '.kordi-app.theme-dark .app-message-reply-line-icon');
  const lightCountRule = cssRule(css, '.kordi-app.theme-light .app-message-reply-count');
  const darkCountRule = cssRule(css, '.kordi-app.theme-dark .app-message-reply-count');
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
  assert.match(block, /document\.querySelector\('\.kordi-app\.theme-light'\)/);
  assert.doesNotMatch(block, /useState\(''\)/);

  const css = readDesktopShellCss();
  const lightRule = cssRule(css, '.app-composer-mention-menu-light');
  assert.match(lightRule, /color-scheme:\s*light;/);
  assert.match(lightRule, /transition:\s*none;/);
});
