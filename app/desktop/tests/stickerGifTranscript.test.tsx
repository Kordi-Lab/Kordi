import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentPreview, attachmentImageDeliveryVisual } from '../src/kordi-app/components/transcriptAttachments';
import type { Message, MessageAttachment } from '../src/kordi-app/types';

const imageMessage: Message = {
  role: 'user', text: '', time: '19:45',
  attachments: [{
    kind: 'image', name: 'Screenshot.png', sizeBytes: 138 * 1024,
    attachmentId: 'att_1', previewUrl: 'data:image/png;base64,preview', mimeType: 'image/png',
  }],
};

test('stickers defer to message actions without opening the image preview', () => {
  const sticker: MessageAttachment = {
    ...imageMessage.attachments![0], subtype: 'sticker', previewUrl: 'data:image/png;base64,sticker-preview',
  };
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, attachments: [sticker] },
  }));
  assert.match(markup, /data-attachment-sticker="true"/);
  assert.doesNotMatch(markup, /data-attachment-image-preview-trigger="true"/);
  assert.match(markup, /Right-click for message actions/);
});

test('GIF messages use compact media sizing', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, attachments: [{
      kind: 'image', name: 'dance.gif', mimeType: 'image/gif', sizeBytes: 80 * 1024,
      attachmentId: null, previewUrl: 'data:image/gif;base64,animated',
    }] },
  }));
  assert.match(markup, /h-\[180px\] w-\[180px\] max-w-full rounded-\[16px\] object-contain/);
  assert.doesNotMatch(markup, /max-h-\[320px\]/);
});

test('GIF loading geometry matches its final compact media surface', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, attachments: [{
      kind: 'image', name: 'dance.gif', mimeType: 'image/gif', sizeBytes: 80 * 1024,
      attachmentId: 'att_gif_loading', previewUrl: null,
    }] },
  }));
  assert.match(markup, /data-attachment-image-loading="true"/);
  assert.match(markup, /h-\[180px\] w-\[180px\] min-h-0 aspect-auto/);
});

test('sticker metadata reserves a transparent non-square loading frame', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...imageMessage, attachments: [{
      kind: 'image', name: 'sticker.png', subtype: 'sticker', sizeBytes: 80 * 1024,
      attachmentId: 'att_sticker_loading', previewUrl: null, widthPixels: 343, heightPixels: 361,
    }] },
  }));
  assert.match(markup, /data-attachment-image-dimensions="true"/);
  assert.match(markup, /width:171px/);
  assert.match(markup, /aspect-ratio:171 \/ 180/);
  assert.match(markup, /bg-transparent/);
  assert.doesNotMatch(markup, /h-\[180px\] w-\[180px\]/);
});

test('upload failures override stale pending delivery status', () => {
  assert.deepEqual(attachmentImageDeliveryVisual('pending_send', 'Upload request failed'), {
    kind: 'failed', label: 'Upload request failed',
  });
});
