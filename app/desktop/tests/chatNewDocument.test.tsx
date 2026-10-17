import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import type { AttachmentItem } from '../src/features/chat/composerController.types';
import { clearCloudAttachmentLocalPathCache, rememberUploadedAttachmentSource } from '../src/features/cloud/cloudAttachmentLocalPathCache';
import { ChatDocumentEntries } from '../src/features/documents/ChatDocumentEntries';
import { chatDocumentNames, newDocumentBaseName, newDocumentFile, nextDocumentFileName } from '../src/features/documents/chatDocuments';
import { DocumentReaderHostContext } from '../src/features/documents/documentReaderHost';
import type { Message, MessageAttachment, SessionArtifact } from '../src/kordi-app/types';
import {
  CACHED_COPY_PATH,
  STORED_PATH,
  attachmentMessage,
  button,
  click,
  conversation,
  hostWith,
  nameField,
  pressEnter,
  pressEscape,
  storedItem,
  typeName,
} from './helpers/chatDocumentEntryDom';
import { withJsdomRoot } from './helpers/mountWithJsdom';

test('a new document takes the typed name, numbered past the names the chat already has', async () => {
  assert.equal(newDocumentBaseName('  Launch plan  '), 'Launch plan');
  assert.equal(newDocumentBaseName('notes.md'), 'notes');
  assert.equal(newDocumentBaseName('Notes.MARKDOWN'), 'Notes');
  assert.equal(newDocumentBaseName('a/b\\c:d'), 'a b c d', 'no path separators');
  assert.equal(newDocumentBaseName('..hidden'), 'hidden');
  for (const name of ['', '   ', '.md', ' / ', 'Untitled', 'untitled.md', 'Untitled 2']) assert.equal(newDocumentBaseName(name), null, `"${name}" is not a name`);
  assert.equal(newDocumentBaseName('Untitled ideas'), 'Untitled ideas');
  assert.equal(newDocumentBaseName('x'.repeat(300))?.length, 120);

  assert.equal(nextDocumentFileName('Plan', []), 'Plan.md');
  assert.equal(nextDocumentFileName('Plan', ['notes.md']), 'Plan.md');
  assert.equal(nextDocumentFileName('Plan', ['plan.md', ' Plan 2.md ', 'Plan 4.md']), 'Plan 3.md');
  const names = chatDocumentNames(
    [{ id: 'a', path: 'notes/Plan.md', name: '', kind: 'document', summary: '' }],
    [attachmentMessage('m1', { name: 'Plan 2.md', attachmentId: 'att_2' })],
  );
  assert.deepEqual(names, ['Plan.md', 'Plan 2.md']);

  const file = newDocumentFile(' Plan.md ', names);
  assert.ok(file);
  assert.equal(file.name, 'Plan 3.md');
  assert.equal(file.type, 'text/markdown');
  assert.equal(await file.text(), '# Plan\n', 'a new document starts with its name as the heading');
  assert.equal(newDocumentFile('   ', names), null);
  assert.equal(newDocumentFile('Untitled', names), null);
});

test('New document sends nothing until a name is confirmed', async () => {
  await withJsdomRoot(async (mount) => {
    const stored: File[] = [];
    const sent: AttachmentItem[] = [];
    const host = hostWith((attachment) => { sent.push(attachment); });
    const root = await mount(createElement(DocumentReaderHostContext.Provider, { value: host },
      createElement(ChatDocumentEntries, {
        conversationId: conversation.id,
        messages: [],
        artifacts: [],
        store: async (file: File) => { stored.push(file); return storedItem(file); },
        open: () => {},
      })));
    const trigger = button(root, 'New document');
    assert.equal(trigger.textContent, '', 'a small icon entry, not a labelled button');
    assert.ok(!nameField(root));

    await click(trigger);
    assert.deepEqual([stored.length, sent.length], [0, 0], 'the click alone sends nothing');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(window.document.activeElement === nameField(root), 'the name field takes focus');
    assert.equal(nameField(root)?.placeholder, 'Document name');

    await typeName(root, 'Plan');
    await pressEscape(root);
    assert.ok(!nameField(root), 'Escape closes the field');
    assert.ok(window.document.activeElement === trigger, 'focus returns to New document');

    await click(trigger);
    assert.equal(nameField(root)?.value, '', 'a closed field keeps no name');
    await typeName(root, 'Plan');
    await click(button(root, 'Cancel'));
    assert.ok(!nameField(root));
    assert.ok(window.document.activeElement === trigger, 'focus returns after Cancel');

    for (const name of ['', '   ', 'Untitled', 'untitled.md']) {
      await click(trigger);
      await typeName(root, name);
      assert.equal(button(root, 'Create').disabled, true, `"${name}" cannot be created`);
      await pressEnter(root);
      assert.ok(nameField(root), 'Enter on a name it cannot take keeps the field open');
      await pressEscape(root);
    }
    assert.deepEqual([stored.length, sent.length], [0, 0], 'no empty or Untitled document is ever sent');
    assert.equal(root.querySelector('[role="alert"]'), null);
  });
});

test('New document sends the named Markdown file through the chat attachment send, then opens the sent copy', async () => {
  clearCloudAttachmentLocalPathCache();
  await withJsdomRoot(async (mount) => {
    const stored: File[] = [];
    const sent: AttachmentItem[] = [];
    const opened: MessageAttachment[] = [];
    const artifacts: SessionArtifact[] = [{ id: 'notes/Plan.md', path: 'notes/Plan.md', name: 'Plan.md', kind: 'document', category: 'artifact', summary: 'Created' }];
    let finishSend: () => void = () => {};
    // The upload is done at once; the send itself is still in flight.
    const host = hostWith((attachment) => new Promise<void>((resolve) => {
      sent.push(attachment);
      rememberUploadedAttachmentSource(attachment.path, 'att_new');
      finishSend = resolve;
    }));
    const entries = (messages: Message[]) => createElement(DocumentReaderHostContext.Provider, { value: host },
      createElement(ChatDocumentEntries, {
        conversationId: conversation.id,
        messages,
        artifacts,
        store: async (file: File) => { stored.push(file); return storedItem(file); },
        open: (attachment: MessageAttachment) => { opened.push(attachment); },
      }));

    const root = await mount(entries([]));
    await click(button(root, 'New document'));
    await typeName(root, '  Plan  ');
    await pressEnter(root);
    assert.ok(!nameField(root), 'Enter creates it and closes the field');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'Plan 2.md', 'the typed name, past the listed Plan.md');
    assert.equal(stored[0].type, 'text/markdown');
    assert.equal(await stored[0].text(), '# Plan\n', 'the document is not empty');
    assert.ok(stored[0].size > 1);
    assert.deepEqual(sent.map((attachment) => [attachment.name, attachment.path, attachment.mimeType]), [['Plan 2.md', STORED_PATH, 'text/markdown']]);
    assert.equal(opened.length, 0, 'nothing opens before the chat has the document');
    assert.equal(button(root, 'New document').disabled, true);
    assert.equal(button(root, 'Add file').disabled, true);

    await mount(entries([attachmentMessage('m1', { name: 'Plan 2.md', localPath: CACHED_COPY_PATH, attachmentId: 'att_new' })]));
    assert.deepEqual(opened.map((attachment) => [attachment.name, attachment.attachmentId]), [['Plan 2.md', 'att_new']]);
    await act(async () => { finishSend(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(opened.length, 1, 'the finished send does not open it again');
    assert.equal(button(root, 'New document').disabled, false);
    assert.equal(root.querySelector('[role="alert"]'), null);
  });
  clearCloudAttachmentLocalPathCache();
});
