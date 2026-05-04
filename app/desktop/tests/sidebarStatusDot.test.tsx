import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { SidebarSessionStatusIndicator } from '../src/pages/WorkspaceSidebar';

test('SidebarSessionStatusIndicator renders nothing without an indicator', () => {
  const html = renderToStaticMarkup(createElement(SidebarSessionStatusIndicator, {}));
  assert.equal(html, '');
});

test('SidebarSessionStatusIndicator renders a single flat dot for a live running session', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarSessionStatusIndicator, {
      indicator: { tone: 'running', label: 'Running', live: true },
    }),
  );
  assert.match(html, /app-session-status-light-running/);
  assert.doesNotMatch(html, /animate-ping/, 'live running dot must not animate');
  assert.doesNotMatch(html, /blur-\[/, 'flat dot must not render a blurred glow span');
  assert.doesNotMatch(html, /ring-/, 'flat dot must not render a ring halo');
});

test('SidebarSessionStatusIndicator emits one tone class per indicator', () => {
  const tones = ['running', 'ready', 'draft', 'error', 'stopped'] as const;
  for (const tone of tones) {
    const html = renderToStaticMarkup(
      createElement(SidebarSessionStatusIndicator, {
        indicator: { tone, label: tone },
      }),
    );
    assert.match(html, new RegExp(`app-session-status-light-${tone}`));
  }
});

test('status dot CSS exposes a single base rule plus per-tone variables for both themes', () => {
  const css = readDesktopShellCss();

  assert.match(
    css,
    /\.app-session-status-light\s*{[^}]*background-color:\s*var\(--kordi-status-dot[^)]*\)/s,
    'base rule should drive background-color from --kordi-status-dot',
  );

  for (const tone of ['running', 'ready', 'draft', 'error', 'stopped']) {
    assert.match(
      css,
      new RegExp(`\\.app-session-status-light-${tone}\\s*{[^}]*--kordi-status-dot:`, 's'),
      `dark theme should set --kordi-status-dot for ${tone}`,
    );
    assert.match(
      css,
      new RegExp(`\\.theme-light\\s+\\.app-session-status-light-${tone}\\s*{[^}]*--kordi-status-dot:`, 's'),
      `light theme should override --kordi-status-dot for ${tone}`,
    );
  }

  assert.doesNotMatch(css, /\.app-session-status-light-[a-z]+\s+\.bg-sky-500/, 'no Tailwind alpha override selectors should remain');
});
