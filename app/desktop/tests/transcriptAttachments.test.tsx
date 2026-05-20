import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentImageLightbox, AttachmentPreview, attachmentPreviewIdentity } from '../src/kordi-app/components/transcriptAttachments';

const imageMessage = {
  role: 'user' as const,
  text: '',
  time: '19:45',
  attachments: [{
    kind: 'image' as const,
    name: 'Screenshot 2026-05-20.png',
    sizeBytes: 138 * 1024,
    attachmentId: 'att_1',
    localPath: null,
    previewUrl: 'https://files.test/preview.png',
    mimeType: 'image/png',
  }],
};

const multiImageMessage = {
  ...imageMessage,
  attachments: [
    imageMessage.attachments[0],
    {
      kind: 'image' as const,
      name: 'Screenshot 2026-05-20 20.54.15.png',
      sizeBytes: 61 * 1024,
      attachmentId: 'att_2',
      localPath: null,
      previewUrl: 'https://files.test/preview-2.png',
      mimeType: 'image/png',
    },
    {
      kind: 'image' as const,
      name: 'Screenshot 2026-05-20 20.54.16.png',
      sizeBytes: 168 * 1024,
      attachmentId: 'att_3',
      localPath: null,
      previewUrl: 'https://files.test/preview-3.png',
      mimeType: 'image/png',
    },
  ],
};

test('attachment image preview identity changes when local cache path becomes available', () => {
  const pending = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    localPath: null,
    previewUrl: null,
  });
  const cached = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    localPath: '/tmp/kordi/Screenshot.png',
    previewUrl: null,
  });

  assert.notEqual(cached, pending);
  assert.match(cached, /\/tmp\/kordi\/Screenshot\.png/);
});

test('image attachments render as clickable lightweight previews without heavy footer banner', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.match(markup, /data-attachment-image-card="true"/);
  assert.match(markup, /data-attachment-image-preview-trigger="true"/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
  assert.doesNotMatch(markup, /bg-black\/10/);
  assert.match(markup, /Screenshot 2026-05-20\.png/);
});

test('multiple image attachments render as a banner-free collage', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: multiImageMessage }));

  assert.match(markup, /data-attachment-image-collage="true"/);
  assert.match(markup, /data-attachment-image-count="3"/);
  assert.match(markup, /app-attachment-image-tile/);
  assert.doesNotMatch(markup, /61 KB/);
  assert.doesNotMatch(markup, /168 KB/);
  assert.doesNotMatch(markup, />Screenshot 2026-05-20 20\.54\.15\.png<\/span>/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
});

test('image attachment actions are available from context menu instead of sticky under-image buttons', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.match(markup, /data-attachment-image-context-target="true"/);
  assert.match(markup, /Right-click for image actions/);
  assert.doesNotMatch(markup, /aria-label="Download Screenshot 2026-05-20\.png"/);
});

test('attachment image lightbox renders as a centered modal with close affordance', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentImageLightbox, {
    attachment: imageMessage.attachments[0],
    previewUrl: 'https://files.test/preview.png',
    onClose: () => {},
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /data-attachment-image-lightbox="true"/);
  assert.match(markup, /data-attachment-image-lightbox-panel="true"/);
  assert.match(markup, /items-center justify-center/);
  assert.match(markup, /Preview image/);
  assert.doesNotMatch(markup, />Image preview</);
  assert.match(markup, /Close image preview/);
});
