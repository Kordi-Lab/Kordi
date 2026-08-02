import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Button } from '../src/components/ui/button';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('Button exposes a semantic quiet variant without changing secondary actions', () => {
  const quietMarkup = renderToStaticMarkup(createElement(Button, { variant: 'quiet' }, 'Ask Agent'));
  const secondaryMarkup = renderToStaticMarkup(createElement(Button, { variant: 'secondary' }, 'Cancel'));

  assert.match(quietMarkup, /class="[^"]*app-button-quiet[^"]*"/);
  assert.doesNotMatch(quietMarkup, /app-control-chip/);
  assert.match(secondaryMarkup, /class="[^"]*app-control-chip[^"]*"/);
  assert.doesNotMatch(secondaryMarkup, /app-button-quiet/);
});

test('quiet controls are borderless at rest and define complete interaction states', () => {
  const shellCss = readDesktopShellCss();
  const quietBase = shellCss.match(/\.app-button-quiet,[\s\S]*?\.app-utility-button \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(quietBase, /border:\s*1px solid transparent;/);
  assert.match(quietBase, /background:\s*transparent;/);
  assert.match(quietBase, /box-shadow:\s*none;/);
  assert.match(quietBase, /--app-quiet-control-duration/);
  assert.match(shellCss, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(shellCss, /\.app-button-quiet:active:not\(:disabled\)/);
  assert.match(shellCss, /\.app-button-quiet:focus-visible[\s\S]*outline:\s*2px solid var\(--app-quiet-control-focus-ring\)/);
  assert.match(shellCss, /\.app-button-quiet:is\(\[aria-pressed='true'\], \[aria-expanded='true'\],[\s\S]*\[data-state='open'\]/);
  assert.match(shellCss, /\.app-button-quiet:disabled[\s\S]*color:\s*var\(--app-quiet-control-disabled-text\)/);
  assert.match(shellCss, /@media \(pointer: coarse\)[\s\S]*min-height:\s*44px/);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*0\.01ms/);
  assert.match(shellCss, /@media \(forced-colors: active\)[\s\S]*border-color:\s*ButtonText/);
});

test('quiet controls use semantic tokens in both themes and transient surfaces', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const transientCss = readFileSync(new URL('../src/styles/transient-surfaces.css', import.meta.url), 'utf8');
  const darkTokenBlock = themeTokensCss.match(/\.kordi-app\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightTokenBlock = themeTokensCss.match(/\.kordi-app\.theme-light\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(darkTokenBlock, /--app-quiet-control-hover-bg:/);
  assert.match(darkTokenBlock, /--app-quiet-control-focus-ring:/);
  assert.match(darkTokenBlock, /--app-quiet-control-duration:\s*150ms;/);
  assert.match(lightTokenBlock, /--app-quiet-control-hover-bg:/);
  assert.match(lightTokenBlock, /--app-quiet-control-focus-ring:/);
  assert.match(transientCss, /\.app-transient-surface\s*\{[\s\S]*--app-quiet-control-hover-bg:\s*var\(--app-transient-hover-bg\)/);
});
