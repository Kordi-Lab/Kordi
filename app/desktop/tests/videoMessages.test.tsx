import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  attachmentsAreOnlyMp4Videos,
  isMp4VideoAttachment,
} from '../src/features/chat/attachmentMediaGallery';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
import { captureVideoPosterDataUrl } from '../src/features/chat/composerAttachments';
import {
  formatVideoRecordingDuration,
  preferredMp4RecordingMimeType,
} from '../src/features/chat/useVideoMessageRecorder';
import type { Message } from '../src/kordi-app/types';

test('MP4 classification prefers MIME metadata and only falls back for untyped files', () => {
  assert.equal(isMp4VideoAttachment({
    kind: 'file',
    name: 'recording.bin',
    mimeType: 'video/mp4',
  }), true);
  assert.equal(isMp4VideoAttachment({
    kind: 'file',
    name: 'recording.mp4',
    mimeType: null,
  }), true);
  assert.equal(isMp4VideoAttachment({
    kind: 'file',
    name: 'document.mp4',
    mimeType: 'application/pdf',
  }), false);
});

test('MP4 attachments stay poster-backed until explicit playback instead of rendering file links', () => {
  const message: Message = {
    role: 'user',
    text: '',
    time: '12:30',
    attachments: [{
      attachmentId: 'att-large-video',
      kind: 'file',
      name: 'Video 2026-08-28.mp4',
      mimeType: 'video/mp4',
      previewUrl: 'data:image/jpeg;base64,cG9zdGVy',
      sizeBytes: 148 * 1024 * 1024,
    }],
  };

  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: message }));

  assert.match(markup, /data-attachment-video-card="true"/);
  assert.match(markup, /aria-label="Play Video 2026-08-28\.mp4"/);
  assert.match(markup, /w-\[min\(520px,70vw\)\]/);
  assert.match(markup, /lucide-play/);
  assert.match(markup, /<img/);
  assert.doesNotMatch(markup, /Stream the video/);
  assert.doesNotMatch(markup, />Play video</);
  assert.doesNotMatch(markup, /<video/);
  assert.doesNotMatch(markup, /data-attachment-file-link="true"/);
});

test('video-only messages use the borderless media surface', () => {
  const videoMessage: Message = {
    role: 'user',
    text: '',
    time: '12:30',
    attachments: [{
      kind: 'file',
      name: 'Video 2026-08-28.mp4',
      mimeType: 'video/mp4',
    }],
  };

  assert.equal(attachmentsAreOnlyMp4Videos(videoMessage.attachments), true);
  assert.equal(attachmentsAreOnlyMp4Videos([{ kind: 'file', name: 'notes.txt' }]), false);
});

test('sending videos keep the final card geometry and move progress into the media', () => {
  const message: Message = {
    role: 'user',
    text: '',
    time: '12:30',
    statusChips: ['sending'],
    attachments: [{
      kind: 'file',
      name: 'Video 2026-08-28.mp4',
      mimeType: 'video/mp4',
      previewUrl: 'data:image/jpeg;base64,cG9zdGVy',
      sizeBytes: 1_024,
    }],
  };

  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: message }));

  assert.match(markup, /data-attachment-video-card="true"/);
  assert.match(markup, /aspect-video/);
  assert.match(markup, /aria-label="Sending video"/);
  assert.doesNotMatch(markup, /<video/);
});

test('video recording selects MP4 only and keeps duration copy stable', () => {
  const supported = new Set(['video/mp4']);
  assert.equal(
    preferredMp4RecordingMimeType((mimeType) => supported.has(mimeType)),
    'video/mp4',
  );
  assert.equal(preferredMp4RecordingMimeType(() => false), null);
  assert.equal(formatVideoRecordingDuration(61_000), '1:01');
});

test('video posters downsample a single frame instead of retaining video bytes', () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let drewFrame = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => { drewFrame = true; } }),
    toDataURL: () => 'data:image/jpeg;base64,cG9zdGVy',
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  });
  try {
    const poster = captureVideoPosterDataUrl({
      videoWidth: 1_920,
      videoHeight: 1_080,
    } as HTMLVideoElement);
    assert.equal(poster, 'data:image/jpeg;base64,cG9zdGVy');
    assert.equal(canvas.width, 480);
    assert.equal(canvas.height, 270);
    assert.equal(drewFrame, true);
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('large video paths stay chunked and file-backed', () => {
  const recorder = readFileSync(
    new URL('../src/features/chat/useVideoMessageRecorder.ts', import.meta.url),
    'utf8',
  );
  const attachments = readFileSync(
    new URL('../src/features/chat/composerAttachments.ts', import.meta.url),
    'utf8',
  );
  const desktopStream = readFileSync(
    new URL('../src/lib/desktopAttachmentStream.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(recorder, /new Blob\(chunks/);
  assert.doesNotMatch(attachments, /file\.arrayBuffer\(\)/);
  assert.match(attachments, /file\.size > MAX_IN_MEMORY_ATTACHMENT_BYTES && file\.type\?\.startsWith\('image\/'\)/);
  assert.match(desktopStream, /file\.slice\(offset, offset \+ chunkSize\)/);
  assert.match(recorder, /appendDesktopChatAttachmentStream/);
  assert.match(recorder, /videoBitsPerSecond: VIDEO_BITS_PER_SECOND/);
  assert.match(recorder, /frameRate: \{ ideal: 30, max: 30 \}/);
  assert.doesNotMatch(recorder, /phase: 'sending'/);
  assert.ok(recorder.indexOf("clear(false)") > recorder.indexOf("onSend('', [attachment])"));
});
