import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import type { AttachmentItem } from '../src/features/chat/composerController.types';
import { ChatDocumentEntries } from '../src/features/documents/ChatDocumentEntries';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import type { MessageAttachment } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const FORMAT_HELP = 'Choose a Markdown or HTML document (.md, .markdown, .html, or .htm). Send other files from the chat composer.';

test('Artifacts rejects plain text with a format reason before storing, then accepts an untyped Markdown retry', async () => {
  await withJsdomRoot(async (mount) => {
    const stored: File[] = [];
    const sent: AttachmentItem[] = [];
    const opened: MessageAttachment[] = [];
    let failStorage = false;
    const host: DocumentReaderHost = {
      viewer: null, sessionId: 'synthetic-chat', agentName: null, people: [],
      addDocument: (attachment) => { sent.push(attachment); },
    };
    const entries = (messages: Parameters<typeof ChatDocumentEntries>[0]['messages'] = []) => createElement(
      DocumentReaderHostContext.Provider,
      { value: host },
      createElement(ChatDocumentEntries, {
        conversationId: 'synthetic-chat', artifacts: [], messages,
        store: async (file: File) => {
          if (failStorage) throw new Error('Private storage diagnostics must not appear in the UI');
          stored.push(file);
          return { id: 'synthetic-file', name: file.name, path: '/tmp/synthetic-plan.md', kind: 'file', mimeType: file.type };
        },
        open: (attachment: MessageAttachment) => { opened.push(attachment); },
      }),
    );
    const root = await mount(entries());
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    const helpId = input.getAttribute('aria-describedby');
    assert.ok(helpId);
    assert.equal(document.getElementById(helpId)?.textContent, 'Markdown and HTML documents');
    assert.equal(Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Add file')?.getAttribute('aria-describedby'), helpId);
    const pick = async (file: File) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => {
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    };

    await pick(new File(['Synthetic plain text'], 'notes.txt', { type: 'text/plain' }));
    assert.equal(root.querySelector('[role="alert"]')?.textContent, FORMAT_HELP);
    assert.equal(stored.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(opened.length, 0);
    assert.equal(input.value, '', 'the same file can be selected again after validation');

    const markdown = '# Synthetic plan\n\n- Keep the complete body.\n- Preserve line breaks.\n';
    await pick(new File([markdown], 'plan.md'));
    assert.equal(root.querySelector('[role="alert"]'), null);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, 'text/markdown');
    assert.equal(await stored[0].text(), markdown);
    assert.equal(sent[0].name, 'plan.md');
    assert.equal(sent[0].mimeType, 'text/markdown');
    await mount(entries([{
      id: 'synthetic-message', role: 'user', text: '', time: '10:00',
      attachments: [{ kind: 'file', name: 'plan.md', localPath: '/tmp/synthetic-plan.md', attachmentId: 'synthetic-upload' }],
    }]));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].attachmentId, 'synthetic-upload');

    failStorage = true;
    await pick(new File(['# Retry'], 'retry.md'));
    assert.equal(root.querySelector('[role="alert"]')?.textContent, 'Could not add the document.');
    assert.equal(sent.length, 1);
  });
});
