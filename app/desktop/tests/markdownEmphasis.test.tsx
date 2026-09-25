import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownContent } from '../src/kordi-app/components/markdown';
import { HumanMessageMarkdown } from '../src/kordi-app/components/humanMessageMarkdown';

const href = 'https://example.com/docs';

function render(text: string) {
  return renderToStaticMarkup(createElement(MarkdownContent, { text }));
}

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, '');
}

function assertLabelLink(html: string) {
  assert.equal((html.match(/<a\b/g) ?? []).length, 1);
  assert.match(html, /<a[^>]+href="https:\/\/example\.com\/docs"[^>]+data-external-message-link="true"[^>]*><span>label<\/span><\/a>/);
}

for (const marker of ['*', '**', '_', '__', '***', '___']) {
  test(`renders a clickable label inside ${marker} emphasis`, () => {
    const html = render(`${marker}[label](${href})${marker}`);

    assertLabelLink(html);
    assert.equal(visibleText(html), 'label');
    if (marker.length >= 2) assert.match(html, /<strong[^>]*>.*<a\b.*<\/strong>/);
    if (marker.length !== 2) assert.match(html, /<em[^>]*>.*<a\b.*<\/em>/);
  });
}

test('renders links in nested emphasis with surrounding text and adjacent closing markers', () => {
  for (const text of [
    `**before *[label](${href})* after**`,
    `*before **[label](${href})***`,
    `**before *[label](${href})***`,
    `__before _[label](${href})___`,
    `**before _[label](${href})_ after**`,
  ]) {
    const html = render(text);
    assertLabelLink(html);
    assert.match(html, /<strong\b/);
    assert.match(html, /<em\b/);
    assert.equal(visibleText(html), text.includes(' after') ? 'before label after' : 'before label');
  }
});

test('keeps emphasized links working inside nested lists', () => {
  const html = render(`- Parent\n  - **[label](${href})**`);
  assert.equal((html.match(/<li\b/g) ?? []).length, 2);
  assert.match(html, /<li[^>]*>.*<strong[^>]*><a\b/);
  assertLabelLink(html);
  assert.equal(visibleText(html), 'Parentlabel');
});

test('does not interpret emphasis markers inside link labels or destinations', () => {
  for (const marker of ['*', '**', '_', '__', '***']) {
    const html = render(`${marker}[label_*](https://example.com/a_*b_(c))${marker}`);
    assert.equal((html.match(/<a\b/g) ?? []).length, 1);
    assert.match(html, /href="https:\/\/example\.com\/a_\*b_\(c\)"/);
    assert.equal(visibleText(html), 'label_*');
  }
});

test('keeps inline code literal inside and outside emphasis', () => {
  const code = `*[label](${href})*`;
  for (const text of [`\`${code}\``, `**\`${code}\`**`]) {
    const html = render(text);
    assert.match(html, /<code\b/);
    assert.doesNotMatch(html, /<a\b|<em\b/);
    assert.equal(visibleText(html), code);
  }
});

test('keeps ordinary underscores, unmatched markers, and escaped emphasis literal', () => {
  for (const text of ['some_variable_name', 'some__variable__name', '\u4e2d\u6587_\u53d8\u91cf_\u540d\u79f0', '**unfinished', 'a * b * c', '__ spaced __']) {
    const html = render(text);
    assert.doesNotMatch(html, /<strong\b|<em\b/);
    assert.equal(visibleText(html), text);
  }
  const escaped = render(String.raw`\*literal\* and \_literal\_`);
  assert.doesNotMatch(escaped, /<strong\b|<em\b/);
  assert.equal(visibleText(escaped), '*literal* and _literal_');
});

test('preserves ordinary links, emphasized bare URLs, and unsafe link rejection', () => {
  assertLabelLink(render(`[label](${href})`));
  for (const url of [href, 'https://example.com/_docs']) {
    const bare = render(`**${url}**`);
    assert.match(bare, /<strong[^>]*><a\b/);
    assert.ok(bare.includes(`href="${url}"`));
    assert.equal(visibleText(bare), url);
  }
  assert.doesNotMatch(render('**[label](javascript:alert(1))**'), /<a\b/);
});

test('keeps an unmatched underscore literal within a valid bold wrapper', () => {
  const html = render('**before _literal**');
  assert.match(html, /<strong[^>]*>before _literal<\/strong>/);
  assert.doesNotMatch(html, /<em\b/);
});

test('preserves mentions, emoji, and inherited tone in human message emphasis', () => {
  for (const inline of [false, true]) {
    const html = renderToStaticMarkup(createElement(HumanMessageMarkdown, {
      inline,
      message: {
        role: 'user', sender: 'Me', senderType: 'human', time: '12:00', statusChips: [],
        text: `**@Alex :blob:blobwave: [label](${href})**`,
      },
    }));
    assert.match(html, /app-message-mention/);
    assert.match(html, /blobwave\.webp/);
    assert.match(html, /<strong class="font-semibold">/);
    assert.match(html, /href="https:\/\/example\.com\/docs"/);
    assert.doesNotMatch(visibleText(html), /\*\*|\[label\]|https:/);
  }
});

test('keeps underscores within mention names intact', () => {
  const html = render('@alex_smith and **@alex_smith**');
  assert.equal((html.match(/>@alex_smith<\/span>/g) ?? []).length, 2);
  assert.equal(visibleText(html), '@alex_smith and @alex_smith');
});
