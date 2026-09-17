import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a synced sticker renders from the message kind when the wire carried no subtype', () => {
  // The Cloud server rejects a "sticker" attachment subtype, so neither Mac nor
  // iPhone puts one on the wire. The message kind is the only signal that
  // survives a round trip, and it has to be enough on its own.
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: {
      ...imageMessage,
      messageKind: 'sticker',
      attachments: [{
        ...imageMessage.attachments![0],
        previewUrl: 'data:image/png;base64,sticker-preview',
      }],
    },
  }));

  assert.match(markup, /data-attachment-sticker="true"/);
  assert.doesNotMatch(markup, /data-attachment-image-preview-trigger="true"/);
});

test('a preview swap keeps the decoded image on screen instead of flashing', () => {
  // At 100% the local preview is replaced by the uploaded one. The card must
  // keep the decoded image visible and preload the replacement off-screen,
  // rather than blanking to the loading surface.
  const source = readFileSync(
    new URL('../src/kordi-app/components/AttachmentImageCard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /const displayPreviewUrl = imageLoaded \|\| !loadedPreviewUrl \? previewUrl : loadedPreviewUrl;/);
  assert.match(source, /const displayReady = imageLoaded \|\| displayPreviewUrl === loadedPreviewUrl;/);
  assert.match(source, /\{!displayReady \? \(\s*<AttachmentImageLoadingSurface/);
  assert.match(source, /preloadPreviewUrl \? \([\s\S]*?aria-hidden="true"[\s\S]*?setLoadedPreviewUrl\(preloadPreviewUrl\)/);
  assert.doesNotMatch(source, /imageLoaded \? 'opacity-100' : 'opacity-0'/);
});
