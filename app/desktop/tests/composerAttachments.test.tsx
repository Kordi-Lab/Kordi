import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayAttachmentName,
  friendlyAttachmentName,
  parseStoredComposerAttachments,
  serializeStoredComposerAttachments,
} from '../src/features/chat/composerAttachments';

test('friendlyAttachmentName replaces generic clipboard image names with timestamped screenshot names', () => {
  assert.equal(
    friendlyAttachmentName('image.png', 'image', new Date(2026, 3, 30, 18, 30, 7).getTime()),
    'Screenshot 2026-04-30 18.30.07.png',
  );
  assert.equal(
    friendlyAttachmentName('pi-clipboard-02f68383-cadc-4d8f-83ec-7067805155b7.png', 'image', new Date(2026, 3, 30, 18, 30, 7).getTime()),
    'Screenshot 2026-04-30 18.30.07.png',
  );
});

test('friendlyAttachmentName preserves user-provided image and file names', () => {
  assert.equal(friendlyAttachmentName('architecture-diagram.png', 'image', Date.UTC(2026, 3, 30)), 'architecture-diagram.png');
  assert.equal(friendlyAttachmentName('package.json', 'file', Date.UTC(2026, 3, 30)), 'package.json');
});

test('displayAttachmentName hides generic image filenames in visible image chrome', () => {
  assert.equal(displayAttachmentName('image.png', 'image'), 'Image attachment');
  assert.equal(displayAttachmentName('architecture-diagram.png', 'image'), 'architecture-diagram.png');
  assert.equal(displayAttachmentName('image.png', 'file'), 'image.png');
});

test('stored composer attachments persist durable local paths but drop stale blob preview urls', () => {
  const serialized = serializeStoredComposerAttachments([{
    id: 'first',
    name: 'Screenshot 2026-04-30 18.30.07.png',
    path: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/Screenshot-uuid.png',
    kind: 'image',
    formatLabel: 'PNG',
    mimeType: 'image/png',
    previewUrl: 'blob:http://127.0.0.1:1484/stale',
    sizeBytes: 276000,
  }]);

  assert.deepEqual(parseStoredComposerAttachments(serialized), [{
    id: 'first',
    name: 'Screenshot 2026-04-30 18.30.07.png',
    path: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/Screenshot-uuid.png',
    kind: 'image',
    formatLabel: 'PNG',
    mimeType: 'image/png',
    localPath: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/Screenshot-uuid.png',
    previewUrl: null,
    sizeBytes: 276000,
  }]);
});
