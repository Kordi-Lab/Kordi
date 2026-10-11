import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markdownDocumentTitle, splitMarkdownBlocks } from '../src/features/documents/documentBlocks';

const blocks = (source: string) => splitMarkdownBlocks(source).map(({ id, kind, source: text }) => ({ id, kind, source: text }));

test('headings, paragraphs, and rules are separate blocks in source order', () => {
  assert.deepEqual(blocks('# Title\nFirst line\nsecond line\n\n---\n## Next'), [
    { id: 'b0', kind: 'heading', source: '# Title' },
    { id: 'b1', kind: 'paragraph', source: 'First line\nsecond line' },
    { id: 'b2', kind: 'rule', source: '---' },
    { id: 'b3', kind: 'heading', source: '## Next' },
  ]);
});

test('two paragraphs separated by a blank line are two blocks', () => {
  assert.deepEqual(blocks('One paragraph.\n\nAnother paragraph.\n'), [
    { id: 'b0', kind: 'paragraph', source: 'One paragraph.' },
    { id: 'b1', kind: 'paragraph', source: 'Another paragraph.' },
  ]);
});

test('a fenced code block keeps blank lines until the closing fence', () => {
  const fence = '```ts\nconst a = 1;\n\nconst b = 2;\n```';
  assert.deepEqual(blocks(`Before\n${fence}\nAfter`), [
    { id: 'b0', kind: 'paragraph', source: 'Before' },
    { id: 'b1', kind: 'code', source: fence },
    { id: 'b2', kind: 'paragraph', source: 'After' },
  ]);
  assert.deepEqual(blocks('~~~\n# not a heading\n\n~~~'), [
    { id: 'b0', kind: 'code', source: '~~~\n# not a heading\n\n~~~' },
  ]);
});

test('a list with indented continuation lines is one block', () => {
  const list = '- First item\n  continues here\n- Second item\n\n  still the second item\n1. Numbered';
  assert.deepEqual(blocks(`${list}\n\nAfter the list`), [
    { id: 'b0', kind: 'list', source: list },
    { id: 'b1', kind: 'paragraph', source: 'After the list' },
  ]);
});

test('a table runs through its pipe lines', () => {
  const table = '| Paper | Method |\n| --- | :-: |\n| One | Survey |\n| Two | Interviews |';
  assert.deepEqual(blocks(`${table}\nTrailing paragraph`), [
    { id: 'b0', kind: 'table', source: table },
    { id: 'b1', kind: 'paragraph', source: 'Trailing paragraph' },
  ]);
});

test('a blockquote run is one block and a paragraph ends where another block starts', () => {
  assert.deepEqual(blocks('> quoted\n> still quoted\nText\n### Heading\n* * *'), [
    { id: 'b0', kind: 'quote', source: '> quoted\n> still quoted' },
    { id: 'b1', kind: 'paragraph', source: 'Text' },
    { id: 'b2', kind: 'heading', source: '### Heading' },
    { id: 'b3', kind: 'rule', source: '* * *' },
  ]);
});

test('the first level-1 heading is the title', () => {
  assert.equal(markdownDocumentTitle('Intro\n\n## Section\n\n# Kordi related work\n'), 'Kordi related work');
  assert.equal(markdownDocumentTitle('No heading here'), null);
  assert.deepEqual(splitMarkdownBlocks(''), []);
});
