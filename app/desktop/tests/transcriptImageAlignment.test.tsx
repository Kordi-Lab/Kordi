import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
import type { Message } from '../src/kordi-app/types';

const ownImageMessage: Message = {
  role: 'user',
  sender: 'Me',
  senderType: 'human',
  isOwnMessage: true,
  text: '',
  time: '21:09',
  attachments: [{
    kind: 'image',
    name: 'Screenshot.png',
    previewUrl: 'https://files.test/preview.png',
    mimeType: 'image/png',
  }],
};

test('image-only human messages use compact borderless attachment padding', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: ownImageMessage }));

  assert.match(markup, /max-w-\[31rem\]/);
  assert.match(markup, /data-message-media-side="own"/);
  assert.match(markup, /p-0/);
  assert.match(markup, /bg-transparent/);
  assert.match(markup, /shadow-none/);
  assert.doesNotMatch(markup, /app-message-bubble-shape|app-message-footer|px-4 py-2\.5/);
});

test('image-only messages align their outside edge with the text bubble body', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...ownImageMessage, role: 'person', sender: 'Shu Yang', isOwnMessage: false },
  }));
  const stylesheet = readFileSync(new URL('../src/styles/shell-bubbles.css', import.meta.url), 'utf8');

  assert.match(markup, /data-message-media-side="peer"/);
  assert.doesNotMatch(stylesheet, /app-message-media-edge-offset|\[data-message-media-side[^}]*translateX/);
  assert.match(stylesheet, /data-message-media-side="own"[\s\S]*align-self:\s*flex-end;/);
  assert.match(stylesheet, /data-message-media-side="peer"[\s\S]*align-self:\s*flex-start;/);
});

test('pending and remote image placeholders reserve a stable media frame', () => {
  const remoteMarkup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: ownImageMessage }));
  const pendingMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...ownImageMessage, statusChips: ['sending'], attachments: [{ ...ownImageMessage.attachments[0]!, previewUrl: null }] },
  }));
  const stylesheet = readFileSync(new URL('../src/styles/shell-image-groups.css', import.meta.url), 'utf8');

  assert.match(remoteMarkup, /data-attachment-image-loaded="false"/);
  assert.match(remoteMarkup, /col-span-6 row-span-3/);
  assert.match(remoteMarkup, /block h-full w-full/);
  assert.doesNotMatch(remoteMarkup, /inline-flex h-auto w-auto max-w-full/);
  assert.match(stylesheet, /data-attachment-image-loaded="false"[\s\S]*width:\s*min\(100%, 20rem\);[\s\S]*grid-auto-rows:\s*4rem;/);
  assert.match(pendingMarkup, /data-attachment-image-loading="true"/);
  assert.match(pendingMarkup, /w-\[min\(100%,20rem\)\]/);
  assert.match(pendingMarkup, /aspect-\[4\/3\]/);
});

test('image metadata reserves the final frame before the preview loads', () => {
  const attachment = {
    ...ownImageMessage.attachments![0]!,
    widthPixels: 1_600,
    heightPixels: 900,
  };
  const remoteMarkup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...ownImageMessage, attachments: [attachment] },
  }));
  const pendingMarkup = renderToStaticMarkup(createElement(AttachmentPreview, {
    msg: { ...ownImageMessage, attachments: [{ ...attachment, previewUrl: null }] },
  }));

  for (const markup of [remoteMarkup, pendingMarkup]) {
    assert.match(markup, /data-attachment-image-dimensions="true"/);
    assert.match(markup, /width:464px/);
    assert.match(markup, /aspect-ratio:464 \/ 261/);
    assert.doesNotMatch(markup, /col-span-6 row-span-3/);
  }
});

test('captioned image groups render outside the message bubble', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: {
      ...ownImageMessage,
      text: 'The screenshots show the issue.',
      attachments: [
        ownImageMessage.attachments![0]!,
        { ...ownImageMessage.attachments![0]!, name: 'Screenshot 2.png' },
      ],
    },
  }));

  assert.match(markup, /data-message-mixed-images="true"/);
  assert.match(markup, /data-message-detached-image-group="true"/);
  assert.ok(markup.indexOf('data-attachment-image-group-shell') < markup.indexOf('data-message-caption-bubble="true"'));
  assert.match(markup, /max-w-\[31rem\]/);
  assert.doesNotMatch(markup, /max-w-\[52rem\]/);
});

for (const own of [true, false]) {
  for (const text of ['Synthetic mixed send.', '']) {
    for (const imageCount of [1, 2]) {
      test(`mixed send keeps ${imageCount} images outside the ${own ? 'own' : 'peer'} bubble with caption=${Boolean(text)}`, () => {
        const images = Array.from({ length: imageCount }, (_, index) => ({
          ...ownImageMessage.attachments![0]!, name: `image-${index}.png`, attachmentId: `image-${index}`,
        }));
        const message: Message = {
          ...ownImageMessage, id: 'mixed-send', sender: 'Synthetic Sender', showSenderMeta: true,
          role: own ? 'user' : 'person', isOwnMessage: own, text, statusChips: ['read'],
          attachments: [
            images[0], { kind: 'file', name: 'first.txt', attachmentId: 'file-1', mimeType: 'text/plain' },
            ...images.slice(1), { kind: 'file', name: 'second.txt', attachmentId: 'file-2', mimeType: 'text/plain' },
          ],
        };
        const dom = new JSDOM(renderToStaticMarkup(createElement(MessageBubble, { msg: message })));
        try {
          const document = dom.window.document;
          const surface = document.querySelector('[data-message-detached-image-group="true"]');
          const caption = surface?.querySelector('[data-message-caption-bubble="true"]');
          assert.ok(surface);
          assert.ok(caption);
          assert.equal(caption.querySelectorAll('[data-attachment-image-card]').length, 0);
          assert.equal(surface.querySelectorAll('[data-attachment-image-card]').length, imageCount);
          assert.equal(surface.querySelectorAll('[data-message-caption-bubble]').length, 1);
          assert.ok(caption.textContent?.includes('Synthetic Sender'));
          assert.ok(caption.textContent?.includes(text));
          assert.ok(caption.textContent?.includes('first.txt'));
          assert.ok(caption.textContent?.includes('second.txt'));
          assert.ok(caption.textContent!.indexOf('first.txt') < caption.textContent!.indexOf('second.txt'));
          assert.deepEqual(Array.from(surface.querySelectorAll('[data-attachment-image-card] img')).map(img => img.getAttribute('alt')), images.map(img => img.name));
          assert.equal(document.querySelectorAll('[data-message-delivery-status="read"][data-message-delivery-glyph]').length, own ? 1 : 0);
          assert.ok(surface.querySelector('[data-attachment-image-preview-trigger]'));
        } finally { dom.window.close(); }
      });
    }
  }
}

test('images without an inline preview remain downloadable beside detached previews', () => {
  const dom = new JSDOM(renderToStaticMarkup(createElement(MessageBubble, {msg: {
    ...ownImageMessage, text: 'Synthetic attachments.', attachments: [
      ownImageMessage.attachments![0]!,
      {kind:'image',name:'original.png',mimeType:'image/png',sizeBytes:12 * 1024 * 1024,attachmentId:'original'},
    ],
  }})));
  try {
    const caption = dom.window.document.querySelector('[data-message-caption-bubble]');
    assert.ok(caption?.querySelector('[data-attachment-file-chip]')?.textContent?.includes('original.png'));
    assert.equal(dom.window.document.querySelectorAll('[data-attachment-image-card]').length, 1);
    assert.equal(caption?.querySelectorAll('[data-attachment-image-card]').length, 0);
  } finally { dom.window.close(); }
});
