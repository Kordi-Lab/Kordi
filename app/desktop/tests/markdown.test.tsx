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

test('emphasizes mentions in agent markdown regardless of markdown weight', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '@AlexMorgansKordi, please ask **@EthanParksKordi** to reply.',
  }));

  assert.match(html, /app-message-mention[^>]*>@AlexMorgansKordi<\/span>/);
  assert.match(html, /<strong[^>]*>[^<]*<span class="[^"]*app-message-mention-agent[^"]*"[^>]*>@EthanParksKordi<\/span><\/strong>/);
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

test('keeps wide markdown tables contained inside message responses', () => {
  const markdown = [
    '| Step | Action | Expected result |',
    '| --- | --- | --- |',
    '| 1 | Send a support request with a long description | The response remains readable without clipping |',
  ].join('\n');

  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: markdown }));

  assert.match(html, /aria-label="Scrollable table"/);
  assert.match(html, /max-w-full overflow-x-auto/);
  assert.match(html, /min-w-\[34rem\] table-auto/);
  assert.match(html, /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(html, /w-max/);
});

test('renders step result tables as compact labeled report rows', () => {
  const markdown = [
    '| Step | Action | Expected Result | Actual Result | Status |',
    '| --- | --- | --- | --- | --- |',
    '| 1 | Send a support request | The agent confirms receipt | Kordi Support replied | Pass |',
  ].join('\n');

  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: markdown }));

  assert.match(html, /aria-label="Result steps"/);
  assert.match(html, />Step 1</);
  assert.match(html, /data-status-tone="success"/);
  assert.match(html, />Expected Result</);
  assert.match(html, />Actual Result</);
  assert.doesNotMatch(html, /aria-label="Scrollable table"/);
  assert.doesNotMatch(html, /<table/);
});
