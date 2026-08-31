import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  clearLinkPreviewCacheForTests,
  getLinkPreviewCacheStatsForTests,
  loadLinkPreviewMetadata,
} from '../src/kordi-app/components/linkPreviewMetadata';
import { MessageLinkPreview } from '../src/kordi-app/components/messageLinkPreview';
import { firstExternalMessageLink } from '../src/kordi-app/components/messageLinks';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('link preview extraction skips code and preserves a markdown destination', () => {
  const destination = 'https://example.com/page_(final)?token=redacted';
  const link = firstExternalMessageLink(`\`https://ignored.example\` [Review] (${destination})`);

  assert.deepEqual(link, { href: destination, label: 'Review' });
  assert.equal(firstExternalMessageLink('```\nhttps://ignored.example\n```'), null);
});

test('link preview renders a compact fallback without showing query parameters', () => {
  const url = 'https://example.com/reports/quarterly-review?token=redacted&share=private';
  const html = renderToStaticMarkup(createElement(MessageLinkPreview, { text: url }));
  const copy = html.match(/app-message-link-preview-copy[\s\S]*?<\/span><span class="app-message-link-preview-artwork"/)?.[0] ?? '';

  assert.match(html, /class="app-message-link-preview"/);
  assert.match(html, /data-link-preview-state="idle"/);
  assert.match(copy, /example\.com/);
  assert.match(copy, /quarterly review/);
  assert.doesNotMatch(copy, /token|share|private/);
  assert.match(
    readDesktopShellCss(),
    /\.kordi-app\.theme-light a:not\(\.app-markdown-link\):not\(\.app-message-link-preview\)/,
  );
});

test('link preview metadata requests deduplicate and stay bounded', async () => {
  clearLinkPreviewCacheForTests();
  let calls = 0;
  const invoke = async <T,>(_command: string, args?: Record<string, unknown>): Promise<T> => {
    calls += 1;
    return {
      title: `Title ${args?.url}`,
      description: 'Description',
      imageUrl: 'https://images.example/preview.jpg',
      siteName: 'Example',
    } as T;
  };

  try {
    const url = 'https://example.com/shared';
    const [first, second] = await Promise.all([
      loadLinkPreviewMetadata(url, invoke),
      loadLinkPreviewMetadata(url, invoke),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(first, second);

    await Promise.all(Array.from({ length: 70 }, (_, index) => (
      loadLinkPreviewMetadata(`https://example.com/page-${index}`, invoke)
    )));
    const stats = getLinkPreviewCacheStatsForTests();
    assert.equal(stats.entries, stats.maxEntries);
    assert.equal(stats.inFlight, 0);
  } finally {
    clearLinkPreviewCacheForTests();
  }
});

test('link preview failures use a short retry cooldown', async () => {
  clearLinkPreviewCacheForTests();
  let calls = 0;
  const invoke = async <T,>(): Promise<T> => {
    calls += 1;
    throw new Error('unavailable');
  };

  try {
    await assert.rejects(loadLinkPreviewMetadata('https://example.com/failure', invoke));
    await assert.rejects(loadLinkPreviewMetadata('https://example.com/failure', invoke));
    assert.equal(calls, 1);
    assert.equal(getLinkPreviewCacheStatsForTests().failed, 1);
  } finally {
    clearLinkPreviewCacheForTests();
  }
});
