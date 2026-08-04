import assert from 'node:assert/strict';
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
