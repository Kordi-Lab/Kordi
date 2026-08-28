import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  isMp4VideoAttachment,
} from '../src/features/chat/attachmentMediaGallery';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
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

test('MP4 attachments render as controlled inline video instead of file links', () => {
  const message: Message = {
    role: 'user',
    text: '',
    time: '12:30',
    attachments: [{
      kind: 'file',
      name: 'Video 2026-08-28.mp4',
      mimeType: 'video/mp4',
      previewUrl: 'blob:kordi-video-preview',
      sizeBytes: 1_024,
    }],
  };

  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: message }));

  assert.match(markup, /data-attachment-video-card="true"/);
  assert.match(markup, /<video[^>]*controls=""[^>]*playsInline=""/);
  assert.doesNotMatch(markup, /autoplay/);
  assert.doesNotMatch(markup, /data-attachment-file-link="true"/);
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

test('large video paths stay chunked and file-backed', () => {
  const recorder = readFileSync(
    new URL('../src/features/chat/useVideoMessageRecorder.ts', import.meta.url),
    'utf8',
  );
  const attachments = readFileSync(
    new URL('../src/features/chat/composerAttachments.ts', import.meta.url),
    'utf8',
  );
  const desktop = readFileSync(new URL('../src/lib/desktop.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(recorder, /new Blob\(chunks/);
  assert.doesNotMatch(attachments, /file\.arrayBuffer\(\)/);
  assert.match(desktop, /file\.slice\(offset, offset \+ chunkSize\)/);
  assert.match(recorder, /appendDesktopChatAttachmentStream/);
});
