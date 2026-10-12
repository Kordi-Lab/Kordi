import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function editor(root: HTMLElement) {
  return root.querySelector<HTMLTextAreaElement>('textarea[data-document-editor]');
}

/** Puts a caret after `before` inside a rendered block, then clicks there. */
async function clickInto(root: HTMLElement, blockId: string, before: string) {
  const block = root.querySelector<HTMLElement>(`[data-document-block="${blockId}"] .app-document-markdown`)!;
  const walker = block.ownerDocument.createTreeWalker(block, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.nodeValue?.indexOf(before) ?? -1;
    if (at < 0) continue;
    const range = block.ownerDocument.createRange();
    range.setStart(node, at + before.length);
    range.collapse(true);
    const selection = block.ownerDocument.defaultView!.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => { block.dispatchEvent(new block.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true })); });
    return;
  }
  assert.fail(`"${before}" in ${blockId}`);
}

/**
 * Types into the editor. React chooses its change detection when it loads, before the test window
 * exists, so under Node it misses `input` events; call the element's change handler as React would.
 */
async function type(field: HTMLTextAreaElement, value: string, caret = value.length) {
  const view = field.ownerDocument.defaultView!;
  const propsKey = Object.keys(field).find((key) => key.startsWith('__reactProps'))!;
  const props = (field as unknown as Record<string, { onChange: (event: { target: HTMLTextAreaElement }) => void }>)[propsKey];
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.setSelectionRange(caret, caret);
    props.onChange({ target: field });
  });
}

async function press(field: HTMLTextAreaElement, key: string, caret?: number) {
  const view = field.ownerDocument.defaultView!;
  if (caret !== undefined) field.setSelectionRange(caret, caret);
  await act(async () => { field.dispatchEvent(new view.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
}

async function mountEditable(mount: (element: ReturnType<typeof createElement>) => Promise<HTMLElement>, document: DocumentResponse = sampleDocument('owner')) {
  const { api, calls } = createMemoryDocumentApi(document);
  const root = await mount(createElement(DocumentReader, { attachmentId: document.attachmentId, initialDocument: document, api }));
  const lastSave = () => calls.filter((call) => call.method === 'saveDocumentContent').at(-1)?.args[1] as { baseRevision: number; source: string } | undefined;
  return { root, calls, lastSave };
}

const PARAGRAPH = 'That configuration is the clearest niche for Kordi';

test('a click opens the block for typing at that spot, and typing is saved after the debounce', async () => {
  await withJsdomRoot(async (mount) => {
    const { root, lastSave } = await mountEditable(mount);
    await clickInto(root, 'b3', 'clearest');
    const field = editor(root);
    assert.ok(field, 'the block becomes an editor');
    assert.equal(field.value, sampleDocument('owner').blocks[3].source, 'the editor shows the block Markdown');
    assert.equal(field.selectionStart, field.value.indexOf('clearest') + 'clearest'.length, 'the caret lands where the click was');

    await type(field, field.value.replace('clearest niche', 'clearest added niche'));
    await wait(900);
    const save = lastSave();
    assert.equal(save?.baseRevision, 3);
    assert.match(save?.source ?? '', /the clearest added niche for Kordi/);
  });
});

test('Escape leaves the editor and the block renders from its source', async () => {
  await withJsdomRoot(async (mount) => {
    const { root } = await mountEditable(mount);
    await clickInto(root, 'b3', 'configuration');
    const field = editor(root)!;
    await type(field, field.value.replace('That configuration', 'This configuration'));
    await press(field, 'Escape');
    assert.equal(editor(root), null);
    assert.match(root.querySelector('[data-document-block="b3"]')?.textContent ?? '', /This configuration/);
  });
});

test('Enter at the end makes a new paragraph after the block; Shift+Enter would stay inside it', async () => {
  await withJsdomRoot(async (mount) => {
    const { root, lastSave } = await mountEditable(mount);
    await clickInto(root, 'b3', 'configuration');
    const field = editor(root)!;
    await press(field, 'Enter', field.value.length);
    const next = editor(root)!;
    assert.equal(next.value, '', 'the caret moves to a new, empty paragraph');
    await type(next, 'A brand new paragraph.');
    await wait(900);
    const blocks = lastSave()!.source.split('\n\n');
    const at = blocks.findIndex((block) => block.startsWith(PARAGRAPH));
    assert.equal(blocks[at + 1], 'A brand new paragraph.');
  });
});

test('Enter inside a list adds an item with the next marker', async () => {
  await withJsdomRoot(async (mount) => {
    const { root } = await mountEditable(mount);
    await clickInto(root, 'b5', 'Awareness');
    const field = editor(root)!;
    await press(field, 'Enter', field.value.length);
    assert.equal(editor(root)!.value.endsWith('\n- '), true);
    assert.equal(editor(root)!.selectionStart, editor(root)!.value.length);
  });
});

test('Backspace at the start of an emptied block removes it and goes to the end of the previous block', async () => {
  await withJsdomRoot(async (mount) => {
    const { root, lastSave } = await mountEditable(mount);
    await clickInto(root, 'b3', 'configuration');
    const field = editor(root)!;
    await type(field, '', 0);
    await press(field, 'Backspace', 0);
    const previous = editor(root)!;
    const before = sampleDocument('owner').blocks[2].source;
    assert.equal(previous.value, before, 'the previous block is open');
    assert.equal(previous.selectionStart, before.length, 'with the caret at its end');
    await wait(900);
    assert.doesNotMatch(lastSave()!.source, /That configuration/, 'the block is gone from the saved document');
  });
});

test('a read-only document never opens a block for typing', async () => {
  await withJsdomRoot(async (mount) => {
    const document = { ...sampleDocument('member'), viewerCan: { share: false, react: true, comment: true, askAgent: true, edit: false } };
    const { root } = await mountEditable(mount, document);
    await clickInto(root, 'b3', 'configuration');
    assert.equal(editor(root), null);
  });
});
