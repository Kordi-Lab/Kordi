import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockStyleOf,
  isInlineFormatActive,
  setBlockStyle,
  toggleInlineFormat,
  toggleLink,
  toggleList,
  type InlineFormat,
} from '../src/features/documents/documentFormat';
import { locateSelection, projectMarkdown } from '../src/features/documents/documentSourceMap';
import { insertSourceBlock, replaceSourceBlock } from '../src/features/documents/useDocumentEditing';

test('rendered text maps back to source offsets past emphasis markers', () => {
  const source = 'Kordi is **the clearest** niche, and *the clearest* risk.';
  assert.equal(projectMarkdown(source).text, 'Kordiistheclearestniche,andtheclearestrisk.');
  const first = locateSelection(source, 'the clearest', 0);
  assert.deepEqual(first, { start: source.indexOf('the clearest'), end: source.indexOf('the clearest') + 'the clearest'.length });
  const second = locateSelection(source, 'the clearest', 1);
  assert.equal(source.slice(second!.start, second!.end), 'the clearest');
  assert.equal(second!.start, source.lastIndexOf('the clearest'));
  assert.equal(locateSelection(source, 'missing', 0), null);
});

test('block markers, links, code ticks, and new inline marks are skipped by the projection', () => {
  const source = '## A [linked](https://kordi.ai/) `code` <u>under</u> ~~gone~~ ==marked==';
  assert.equal(projectMarkdown(source).text, 'Alinkedcodeundergonemarked');
  const range = locateSelection(source, 'linked code', 0)!;
  assert.equal(source.slice(range.start, range.end), 'linked](https://kordi.ai/) `code');
  const list = '- first item\n- second item';
  assert.equal(projectMarkdown(list).text, 'firstitemseconditem');
});

const FORMATS: Array<[InlineFormat, string]> = [
  ['bold', 'one **two** three'],
  ['italic', 'one *two* three'],
  ['underline', 'one <u>two</u> three'],
  ['strike', 'one ~~two~~ three'],
  ['code', 'one `two` three'],
  ['highlight', 'one ==two== three'],
];

for (const [format, expected] of FORMATS) {
  test(`${format} wraps the selection and toggles off`, () => {
    const source = 'one two three';
    const range = locateSelection(source, 'two', 0)!;
    const formatted = toggleInlineFormat(source, range, format);
    assert.equal(formatted, expected);
    const again = locateSelection(formatted, 'two', 0)!;
    assert.equal(isInlineFormatActive(formatted, again, format), true);
    assert.equal(toggleInlineFormat(formatted, again, format), source);
  });
}

test('bold and italic stack and come off independently', () => {
  const bold = toggleInlineFormat('one two', locateSelection('one two', 'two', 0)!, 'bold');
  const both = toggleInlineFormat(bold, locateSelection(bold, 'two', 0)!, 'italic');
  assert.equal(both, 'one ***two***');
  const range = locateSelection(both, 'two', 0)!;
  assert.equal(isInlineFormatActive(both, range, 'bold'), true);
  assert.equal(isInlineFormatActive(both, range, 'italic'), true);
  assert.equal(toggleInlineFormat(both, range, 'bold'), 'one *two*');
});

test('links are added with a URL and removed again', () => {
  const source = 'read the review';
  const linked = toggleLink(source, locateSelection(source, 'review', 0)!, 'https://kordi.ai/review');
  assert.equal(linked, 'read the [review](https://kordi.ai/review)');
  assert.equal(toggleLink(linked, locateSelection(linked, 'review', 0)!, ''), source);
});

test('list toggles a dash on every line of the block', () => {
  assert.equal(toggleList('first\nsecond'), '- first\n- second');
  assert.equal(toggleList('- first\n- second'), 'first\nsecond');
  assert.equal(toggleList('1. first\n2. second'), 'first\nsecond');
});

test('Aa changes the block marker between text, headings, and quote', () => {
  assert.equal(setBlockStyle('Summary', 'h1'), '# Summary');
  assert.equal(setBlockStyle('# Summary', 'h2'), '## Summary');
  assert.equal(setBlockStyle('## Summary', 'h3'), '### Summary');
  assert.equal(setBlockStyle('### Summary', 'text'), 'Summary');
  assert.equal(setBlockStyle('one\ntwo', 'quote'), '> one\n> two');
  assert.equal(setBlockStyle('> one\n> two', 'text'), 'one\ntwo');
  assert.equal(blockStyleOf('## Summary'), 'h2');
  assert.equal(blockStyleOf('> quoted'), 'quote');
});

test('drafts replace a block or insert a new one after it', () => {
  const source = '# Title\n\nFirst\n\nSecond';
  assert.equal(replaceSourceBlock(source, 'b1', 'First, edited'), '# Title\n\nFirst, edited\n\nSecond');
  assert.equal(insertSourceBlock(source, 'b1', '- [ ] Task'), '# Title\n\nFirst\n\n- [ ] Task\n\nSecond');
  assert.equal(insertSourceBlock(source, null, '| A |\n| --- |'), '# Title\n\nFirst\n\nSecond\n\n| A |\n| --- |');
});
