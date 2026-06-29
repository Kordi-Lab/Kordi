import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}(?:\\s*,[\\s\\S]*?)?\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

test('jump-to-message highlight is integrated into the original bubble surface', () => {
  const shellCss = readDesktopShellCss();
  const rootRule = cssRule(shellCss, '.app-transcript-message-highlight');

  assert.doesNotMatch(rootRule, /\boutline\s*:/);
  assert.doesNotMatch(rootRule, /\boutline-offset\s*:/);
  assert.match(shellCss, /\.app-transcript-message-highlight\s+:where\(\.app-chat-bubble-user,\s*\.app-chat-bubble-peer,\s*\.app-live-assistant-answer-surface\)/);
  assert.match(shellCss, /\.app-transcript-message-highlight\s+\.app-message-bubble-shape-fill/);
  assert.match(shellCss, /@keyframes\s+app-transcript-message-glow/);
  assert.match(shellCss, /prefers-reduced-motion:\s*reduce[\s\S]*\.app-transcript-message-highlight[\s\S]*animation:\s*none/);
});

test('jump-to-message highlight overrides the whole assistant response surface, not only the folded end fade', () => {
  const shellCss = readDesktopShellCss();
  const baseSurfaceIndex = shellCss.indexOf('.app-live-assistant-answer-surface {');
  const highlightSurfaceIndex = shellCss.indexOf('.app-transcript-message-highlight .app-live-assistant-answer-surface {');
  const highlightSurfaceRule = cssRule(shellCss, '.app-transcript-message-highlight .app-live-assistant-answer-surface');

  assert.ok(baseSurfaceIndex >= 0, 'Missing base assistant response surface rule');
  assert.ok(highlightSurfaceIndex > baseSurfaceIndex, 'Highlighted assistant response surface must be defined after the base surface so it wins the cascade');
  assert.match(highlightSurfaceRule, /--app-live-assistant-answer-bg:/);
  assert.match(highlightSurfaceRule, /background:\s*linear-gradient/);
  assert.match(highlightSurfaceRule, /box-shadow:[\s\S]*inset 0 0 0 1px/);
  assert.match(highlightSurfaceRule, /border-color:/);
});

test('folded content uses compact fades and inline reveal controls instead of overlay chrome', () => {
  const shellCss = readDesktopShellCss();
  const quoteFadeRule = cssRule(shellCss, '.app-source-message-quote-folded::after');
  const answerFadeRule = cssRule(shellCss, '.app-live-assistant-answer-folded::after');
  const revealRowRule = cssRule(shellCss, '.app-fold-reveal-row');
  const revealToggleRule = cssRule(shellCss, '.app-inline-expand-toggle');

  for (const rule of [quoteFadeRule, answerFadeRule]) {
    assert.match(rule, /height:\s*1\.05rem/);
    assert.match(rule, /linear-gradient\(\s*180deg,\s*transparent/);
    assert.doesNotMatch(rule, /backdrop-filter:\s*blur\(/);
    assert.doesNotMatch(rule, /mask-image:/);
    assert.doesNotMatch(rule, /box-shadow:/);
  }

  assert.match(revealRowRule, /display:\s*flex/);
  assert.match(revealToggleRule, /min-height:\s*30px/);
  assert.match(revealToggleRule, /border-radius:\s*9px/);
  assert.doesNotMatch(shellCss, /\.app-source-message-quote-toggle-overlay/);
  assert.doesNotMatch(shellCss, /\.app-live-assistant-answer-toggle-overlay/);
});
