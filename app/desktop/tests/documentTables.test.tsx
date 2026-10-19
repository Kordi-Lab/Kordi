import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Editor as TiptapEditor } from '@tiptap/core';

import { installEditorDom } from './helpers/editorDom';

let restore: () => void = () => undefined;
let Editor: typeof import('@tiptap/core').Editor;
let TextSelection: typeof import('@tiptap/pm/state').TextSelection;
let CellSelection: typeof import('@tiptap/pm/tables').CellSelection;
let extensions: typeof import('../src/features/documents/editor/documentEditorExtensions');
let ids: typeof import('../src/features/documents/editor/documentBlockIds');
let commands: typeof import('../src/features/documents/editor/documentEditorCommands');

before(async () => {
  restore = installEditorDom();
  ({ Editor } = await import('@tiptap/core'));
  ({ TextSelection } = await import('@tiptap/pm/state'));
  ({ CellSelection } = await import('@tiptap/pm/tables'));
  extensions = await import('../src/features/documents/editor/documentEditorExtensions');
  ids = await import('../src/features/documents/editor/documentBlockIds');
  commands = await import('../src/features/documents/editor/documentEditorCommands');
});
after(() => restore());

function editorWith(markdown: string) {
  const editor = new Editor({ extensions: extensions.documentEditorExtensions() });
  editor.commands.setContent(ids.parseBlocks(editor.markdown!, ids.blocksFromSource(markdown)).doc);
  return editor;
}

const hasTable = (editor: TiptapEditor) => {
  let found = false;
  editor.state.doc.descendants((node) => { if (node.type.name === 'table') found = true; return !found; });
  return found;
};

/** Positions inside each table cell's paragraph, in document order. */
function cellPositions(editor: TiptapEditor) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') positions.push(position);
  });
  return positions;
}

function caretInCell(editor: TiptapEditor, index: number) {
  const cell = cellPositions(editor)[index];
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cell + 2)));
}

function press(editor: TiptapEditor, key: string) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event));
}

/** The table the insert tools add under a list item: a header row and a body row, all empty. */
function listWithEmptyTable() {
  const editor = editorWith('- item');
  editor.commands.setTextSelection(editor.state.doc.content.size - 2);
  commands.insertBlock(editor, 'table');
  assert.ok(hasTable(editor));
  return editor;
}

for (const key of ['Backspace', 'Delete']) {
  test(`${key} in an empty table removes the table and keeps the list`, () => {
    const editor = listWithEmptyTable();
    caretInCell(editor, 3);
    press(editor, key);
    assert.equal(hasTable(editor), false);
    assert.equal(editor.state.doc.textContent, 'item');
    editor.destroy();
  });
}

test('Backspace in an empty header-only table removes it', () => {
  const editor = editorWith('Intro\n\n|  |  |\n| --- | --- |');
  caretInCell(editor, 0);
  press(editor, 'Backspace');
  assert.equal(hasTable(editor), false);
  assert.equal(editor.state.doc.textContent, 'Intro');
  editor.destroy();
});

test('Backspace in an empty cell keeps a table that has text', () => {
  const editor = editorWith('| Paper | Method |\n| --- | --- |\n|  |  |');
  caretInCell(editor, 3);
  press(editor, 'Backspace');
  assert.ok(hasTable(editor));
  editor.destroy();
});

test('selecting every cell and pressing Backspace removes a table with text', () => {
  const editor = editorWith('Intro\n\n| Paper | Method |\n| --- | --- |\n| One | Survey |');
  const cells = cellPositions(editor);
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0], cells[cells.length - 1])));
  press(editor, 'Backspace');
  assert.equal(hasTable(editor), false);
  assert.equal(editor.state.doc.textContent, 'Intro');
  editor.destroy();
});

test('Backspace in an empty table that is the whole document leaves an empty paragraph', () => {
  const editor = editorWith('|  |\n| --- |');
  caretInCell(editor, 0);
  press(editor, 'Backspace');
  assert.equal(hasTable(editor), false);
  assert.equal(editor.state.doc.firstChild?.type.name, 'paragraph');
  editor.destroy();
});
