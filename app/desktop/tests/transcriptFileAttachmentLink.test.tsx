import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptFileAttachmentLink } from '../src/kordi-app/components/transcriptFileAttachmentLink';

test('file attachments render as compact transcript links with delivery progress', () => {
  const markup = renderToStaticMarkup(createElement(TranscriptFileAttachmentLink, {
    attachment: {
      kind: 'file',
      name: 'notes.pdf',
      attachmentId: 'att_file_1',
      mimeType: 'application/pdf',
    },
    isSending: true,
  }));

  assert.match(markup, /data-attachment-file-link="true"/);
  assert.match(markup, /app-markdown-link/);
  assert.match(markup, />notes\.pdf</);
  assert.doesNotMatch(markup, /data-attachment-file-card=/);
  assert.match(markup, /data-attachment-sending-indicator="true"/);
  assert.match(markup, /Sending…/);
  assert.match(markup, /animate-spin/);
});

test('file upload cancellation is an external opposite-avatar action with confirmation', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcriptFileAttachmentLink.tsx', import.meta.url), 'utf8');
  const inlineLinkSource = source.slice(source.indexOf('export function TranscriptFileAttachmentLink'));

  assert.match(source, /data-message-upload-cancel-button="true"/);
  assert.match(source, /data-message-transfer-action-side="opposite-avatar"/);
  assert.match(source, />Cancel upload\?</);
  assert.match(source, /Keep uploading/);
  assert.match(source, /Cancel upload/);
  assert.doesNotMatch(inlineLinkSource, /cancelCloudAttachmentUpload/);
});
