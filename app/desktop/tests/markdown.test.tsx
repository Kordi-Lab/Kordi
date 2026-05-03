import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { MarkdownContent, openExternalMarkdownLink } from '../src/kordi-app/components/markdown';

test('renders bare http or https links as external markdown links', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: 'Read https://kordi.ai/docs for details.' }));

  assert.match(html, /<a[^>]+href="https:\/\/kordi\.ai\/docs"/);
  assert.match(html, /<span>https:\/\/kordi\.ai\/docs<\/span>/);
  assert.match(html, /target="_blank"/);
});

test('markdown links use a quiet URL treatment without underlines or external icons', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: 'Open https://www.google.com/ now.' }));
  const shellCss = readDesktopShellCss();
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(html, /\bapp-markdown-link\b/);
  assert.doesNotMatch(html, /\bunderline\b|decoration-cyan|text-cyan/);
  assert.doesNotMatch(html, /<svg\b/);
  assert.match(shellCss, /\.app-markdown-link\s*{[\s\S]*color:\s*var\(--app-markdown-link\);[\s\S]*text-decoration:\s*none;/);
  assert.match(themeTokensCss, /--app-markdown-link:\s*oklch\(/);
});

test('routes markdown link clicks through the desktop external opener', () => {
  const openedUrls: string[] = [];
  let wasPrevented = false;
  const handled = openExternalMarkdownLink(
    {
      button: 0,
      defaultPrevented: false,
      preventDefault: () => {
        wasPrevented = true;
      },
    },
    'https://kordi.ai/docs',
    async (url) => {
      openedUrls.push(url);
      return url;
    },
  );

  assert.equal(handled, true);
  assert.equal(wasPrevented, true);
  assert.deepEqual(openedUrls, ['https://kordi.ai/docs']);
});

test('renders indented fenced code blocks without hanging', () => {
  const markdown = [
    'Before',
    '',
    '   ```json',
    '   {"ok": true}',
    '   ```',
    '',
    'After',
  ].join('\n');

  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: markdown }));

  assert.match(html, /Before/);
  assert.match(html, /After/);
  assert.match(html, /ok/);
});
