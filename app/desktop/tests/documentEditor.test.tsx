import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Editor as TiptapEditor } from '@tiptap/core';

import { installEditorDom } from './helpers/editorDom';

let restore: () => void = () => undefined;
let Editor: typeof import('@tiptap/core').Editor;
let TextSelection: typeof import('@tiptap/pm/state').TextSelection;
let extensions: typeof import('../src/features/documents/editor/documentEditorExtensions');
let ids: typeof import('../src/features/documents/editor/documentBlockIds');
let commands: typeof import('../src/features/documents/editor/documentEditorCommands');
let slash: typeof import('../src/features/documents/editor/documentSlashItems');
let merge: typeof import('../src/features/documents/editor/documentBlockMerge');

before(async () => {
  restore = installEditorDom();
  ({ Editor } = await import('@tiptap/core'));
  ({ TextSelection } = await import('@tiptap/pm/state'));
  extensions = await import('../src/features/documents/editor/documentEditorExtensions');
  ids = await import('../src/features/documents/editor/documentBlockIds');
  commands = await import('../src/features/documents/editor/documentEditorCommands');
  slash = await import('../src/features/documents/editor/documentSlashItems');
  merge = await import('../src/features/documents/editor/documentBlockMerge');
});
after(() => restore());

function editorWith(markdown: string) {
  const editor = new Editor({ extensions: extensions.documentEditorExtensions() });
  editor.commands.setContent(ids.parseBlocks(editor.markdown!, ids.blocksFromSource(markdown)).doc);
  return editor;
}

const markdownOf = (editor: TiptapEditor) => ids.sourceOfBlocks(ids.serializeBlocks(editor.markdown!, editor.getJSON()));
const withoutIds = (markdown: string) => markdown.replace(/\n<!-- k:[A-Za-z0-9_-]+ -->/g, '');

const EVERYTHING = [
  '# Title',
  '## Section',
  '### Detail',
  'Plain **bold** *italic* <u>underline</u> ~~strike~~ `code` ==highlight== [link](https://kordi.ai/).',
  '> A quote',
  '- one\n- two',
  '1. first\n2. second',
  '- [ ] open task\n- [x] done task',
  '```ts\nconst answer = 42;\n```',
  '| Paper | Method |\n| --- | --- |\n| One | Survey |',
  '![diagram](https://kordi.ai/diagram.png)',
  '---',
  'Kept id <!-- k:abcd1234 -->',
  'a == b == c',
].join('\n\n');

test('every node and mark round-trips through Markdown, and every block gets an id comment', () => {
  const editor = editorWith(EVERYTHING);
  const markdown = markdownOf(editor);
  const blocks = markdown.split('\n\n');
  assert.equal(blocks.length, 14);
  for (const block of blocks) {
    const lines = block.split('\n');
    assert.match(lines[lines.length - 1], /^<!-- k:[a-z0-9]{8} -->$/, `id comment on its own line after: ${block}`);
    assert.doesNotMatch(lines.slice(0, -1).join('\n'), /<!--/, 'no comment inside the block');
  }
  // Fences, tables, and dividers end on their own syntax, then the comment.
  assert.match(markdown, /const answer = 42;\n```\n<!-- k:[a-z0-9]{8} -->/);
  assert.match(markdown, /\| One\s*\| Survey\s*\|\n<!-- k:[a-z0-9]{8} -->/);
  assert.match(markdown, /(?:^|\n)---\n<!-- k:[a-z0-9]{8} -->/);
  assert.match(markdown, /- two\n<!-- k:[a-z0-9]{8} -->/);
  const plain = withoutIds(markdown);
  for (const expected of ['# Title', '## Section', '### Detail', '**bold**', '*italic*', '<u>underline</u>', '~~strike~~', '`code`', '==highlight==', '[link](https://kordi.ai/)', '> A quote', '- one\n- two', '1. first\n2. second', '- [ ] open task\n- [x] done task', '```ts\nconst answer = 42;\n```', '![diagram](https://kordi.ai/diagram.png)', '---', 'a == b == c']) {
    assert.ok(plain.includes(expected), `keeps ${JSON.stringify(expected)}`);
  }
  assert.match(plain, /\| Paper\s*\| Method\s*\|/);
  assert.match(markdown, /Kept id\n<!-- k:abcd1234 -->/, 'an id in the older trailing form survives and is written in the own-line form');
  // Parsing the output again changes nothing, ids included.
  const again = editorWith(markdown);
  assert.equal(markdownOf(again), markdown);
  editor.destroy();
  again.destroy();
});

test('a loose list is one block with one id after the whole list', () => {
  const editor = editorWith('- one\n\n- two\n\n- three\n<!-- k:list1234 -->\n\nAfter.');
  const blocks = ids.serializeBlocks(editor.markdown!, editor.getJSON());
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, 'k:list1234');
  assert.match(blocks[0].source, /one[\s\S]*two[\s\S]*three\n<!-- k:list1234 -->$/);
  assert.equal(editor.state.doc.child(0).childCount, 3, 'three items in one list');
  editor.destroy();
});

test('highlight and underline keep spaces outside their markers', () => {
  const editor = editorWith('one two three');
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4, 9)));
  commands.toggleFormat(editor, 'highlight');
  assert.match(markdownOf(editor), /^one ==two== three/);
  editor.destroy();
});

function selectWord(editor: TiptapEditor, word: string) {
  let from = -1;
  editor.state.doc.descendants((node, position) => {
    if (from < 0 && node.isText && node.text?.includes(word)) from = position + node.text.indexOf(word);
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + word.length)));
}

const BUTTONS: Array<[import('../src/features/documents/editor/documentEditorCommands').InlineFormat, string]> = [
  ['bold', '**clearest**'],
  ['italic', '*clearest*'],
  ['underline', '<u>clearest</u>'],
  ['strike', '~~clearest~~'],
  ['code', '`clearest`'],
  ['highlight', '==clearest=='],
];

for (const [format, marked] of BUTTONS) {
  test(`${format} applies to the selection and toggles off`, () => {
    const editor = editorWith('That is the clearest niche.');
    selectWord(editor, 'clearest');
    commands.toggleFormat(editor, format);
    assert.ok(withoutIds(markdownOf(editor)).includes(`the ${marked} niche`));
    assert.ok(commands.activeFormats(editor).includes(format));
    commands.toggleFormat(editor, format);
    assert.equal(withoutIds(markdownOf(editor)), 'That is the clearest niche.');
    editor.destroy();
  });
}

test('Aa, list, and link change the block and the selection', () => {
  const editor = editorWith('That is the clearest niche.');
  selectWord(editor, 'clearest');
  for (const [style, prefix] of [['h1', '# '], ['h2', '## '], ['h3', '### '], ['quote', '> '], ['text', '']] as const) {
    commands.setBlockStyle(editor, style);
    assert.equal(commands.activeBlockStyle(editor), style);
    assert.equal(withoutIds(markdownOf(editor)), `${prefix}That is the clearest niche.`);
  }
  commands.toggleList(editor);
  assert.equal(withoutIds(markdownOf(editor)), '- That is the clearest niche.');
  commands.toggleList(editor);
  selectWord(editor, 'clearest');
  commands.setLink(editor, 'https://kordi.ai/review');
  assert.equal(withoutIds(markdownOf(editor)), 'That is the [clearest](https://kordi.ai/review) niche.');
  commands.setLink(editor, '');
  assert.equal(withoutIds(markdownOf(editor)), 'That is the clearest niche.');
  editor.destroy();
});

test('the slash menu and the insert tools add real blocks at the caret', () => {
  const editor = editorWith('First paragraph.\n\n/tab\n\nLast paragraph.');
  let slashEnd = 0;
  editor.state.doc.forEach((node, offset) => { if (node.textContent === '/tab') slashEnd = offset + node.nodeSize - 1; });
  editor.commands.setTextSelection(slashEnd);
  const found = slash.slashQuery(editor);
  assert.deepEqual(found && { query: found.query }, { query: 'tab' });
  const [table] = slash.slashMatches(found!.query);
  assert.equal(table.id, 'table');
  editor.chain().deleteRange({ from: found!.from, to: found!.to }).run();
  table.run(editor);
  assert.equal(editor.state.doc.child(1).type.name, 'table');
  for (const [tool, type] of [['code', 'codeBlock'], ['checklist', 'taskList']] as const) {
    editor.commands.focus('end');
    commands.insertBlock(editor, tool);
    let found_ = false;
    editor.state.doc.forEach((node) => { if (node.type.name === type) found_ = true; });
    assert.ok(found_, `${tool} inserts a ${type}`);
  }
  editor.commands.focus('end');
  commands.insertBlock(editor, 'image', 'https://kordi.ai/x.png');
  assert.match(markdownOf(editor), /!\[\]\(https:\/\/kordi\.ai\/x\.png\)/);
  editor.destroy();
});

test('a block-by-id merge keeps local edits, takes remote ones, and keeps the block being typed into', () => {
  const block = (id: string, source: string) => ({ id, source });
  const base = [block('k:a', 'A'), block('k:b', 'B'), block('k:c', 'C')];
  const local = [block('k:a', 'A local'), block('k:b', 'B'), block('k:c', 'C local'), block('k:new', 'New')];
  const remote = [block('k:a', 'A'), block('k:b', 'B remote'), block('k:c', 'C remote')];
  const typingInC = merge.mergeBlocks(base, local, remote, 'k:c');
  assert.deepEqual(typingInC.blocks.map((entry) => entry.source), ['A local', 'B remote', 'C local', 'New']);
  assert.equal(typingInC.conflict, true);
  const elsewhere = merge.mergeBlocks(base, local, remote, 'k:a');
  assert.equal(elsewhere.blocks[2].source, 'C remote', 'a block changed on both sides away from the caret takes the remote text');
});

test('code blocks show their language and a copy button outside the content, and an empty one shows a placeholder', () => {
  const editor = editorWith('```ts\nconst answer = 42;\n```\n\n```\n```');
  try {
    const blocks = [...editor.view.dom.querySelectorAll('pre')];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].querySelector('.app-document-code-language')?.textContent, 'ts');
    assert.equal(blocks[0].querySelector('.app-document-code-copy')?.getAttribute('aria-label'), 'Copy code');
    assert.equal(blocks[0].classList.contains('is-empty'), false);
    assert.equal(blocks[1].classList.contains('is-empty'), true);
    assert.equal(blocks[1].getAttribute('data-placeholder'), 'Code');
    assert.equal(blocks[1].querySelector('.app-document-code-language'), null);
    assert.equal(editor.state.doc.child(1).textContent, '', 'the placeholder is not content');
    assert.ok(withoutIds(markdownOf(editor)).startsWith('```ts\nconst answer = 42;\n```\n\n```'));
    assert.doesNotMatch(markdownOf(editor), /Copy/, 'the chrome is not serialized');
  } finally {
    editor.destroy();
  }
});

test('the document editor draws no focus ring around the page; controls keep theirs', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles/document-blocks.css', import.meta.url), 'utf8');
  const rule = /\.app-document-reader \.ProseMirror,\s*\.app-document-reader \.ProseMirror:is\(:focus, :focus-visible, :focus-within\),\s*\.app-document-reader \.app-document-editor-shell:focus-within \{[^}]*outline: none !important;[^}]*box-shadow: none !important;/;
  assert.match(css, rule);
  const block = css.match(rule)![0];
  assert.doesNotMatch(block, /button|input|menu/, 'the rule targets only the editing surface');
  const index = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(index, /@import '\.\/styles\/document-blocks\.css';/);
});
