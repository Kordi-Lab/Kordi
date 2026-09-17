import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}(?:\\s*,[\\s\\S]*?)?\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

test('jump-to-message highlight is one full-width accent band, matching iOS', () => {
  const shellCss = readDesktopShellCss();
  const bandRule = shellCss.match(/\/\* Route-back highlight[\s\S]*?\*\/\n\.app-transcript-message-highlight \{[^}]*\}/)?.[0] ?? '';
  const nestedRule = cssRule(shellCss, '.app-transcript-message-highlight .app-transcript-message-highlight');

  assert.match(bandRule, /--app-transcript-highlight-band:\s*color-mix\(in oklab, var\(--app-chat-accent, var\(--app-sidebar-accent\)\) 16%, transparent\)/);
  assert.match(bandRule, /box-shadow:\s*0 0 0 100vmax var\(--app-transcript-highlight-band\)/);
  assert.match(bandRule, /clip-path:\s*inset\(-3px -100vmax\)/);
  assert.match(bandRule, /animation:\s*app-transcript-message-highlight-band 1500ms/);
  assert.doesNotMatch(bandRule, /\b(?:outline|transform|width|height|padding|margin)\s*:/);
  assert.match(nestedRule, /box-shadow:\s*none/);
  assert.match(shellCss, /@keyframes app-transcript-message-highlight-band/);
  assert.doesNotMatch(shellCss, /\.app-transcript-message-highlight \.app-(?:chat-bubble-user|chat-bubble-peer|live-assistant-answer-surface|message-bubble-shape-fill)/);
});

test('reduced motion keeps the highlight band without animating it', () => {
  const shellCss = readDesktopShellCss();
  assert.match(
    shellCss,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.app-transcript-message-highlight \{\s*animation: none;/,
  );
});

test('folded content uses compact fades and inline reveal controls instead of overlay chrome', () => {
  const shellCss = readDesktopShellCss();
  const answerFadeRule = cssRule(shellCss, '.app-live-assistant-answer-folded::after');
  const revealRowRule = cssRule(shellCss, '.app-fold-reveal-row');
  const revealToggleRule = cssRule(shellCss, '.app-inline-expand-toggle');

  for (const rule of [answerFadeRule]) {
    assert.match(rule, /height:\s*1\.05rem/);
    assert.match(rule, /linear-gradient\(\s*180deg,\s*transparent/);
    assert.doesNotMatch(rule, /backdrop-filter:\s*blur\(/);
    assert.doesNotMatch(rule, /mask-image:/);
    assert.doesNotMatch(rule, /box-shadow:/);
  }

  assert.match(revealRowRule, /display:\s*flex/);
  assert.match(revealToggleRule, /min-height:\s*30px/);
  assert.match(revealToggleRule, /border-radius:\s*9px/);
  assert.doesNotMatch(shellCss, /\.app-source-message-quote-(?:folded|toggle)/);
  assert.doesNotMatch(shellCss, /\.app-live-assistant-answer-toggle-overlay/);
});
