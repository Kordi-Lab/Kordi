import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
