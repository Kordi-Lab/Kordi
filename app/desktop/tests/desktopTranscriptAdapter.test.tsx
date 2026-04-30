import assert from 'node:assert/strict';
import test from 'node:test';

import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import type { DesktopChatMessage } from '../src/kordi-app/types';

test('desktop transcript attachment mapping preserves file size and local preview path metadata', () => {
  const messages: DesktopChatMessage[] = [{
    role: 'user',
    sender: 'Me',
    text: '',
    timeLabel: '10:59',
    timestampMs: 1,
    attachments: [{
      kind: 'image',
      name: 'Screenshot 2026-04-30 10.59.00.png',
      formatLabel: 'PNG',
      previewUrl: null,
      mimeType: 'image/png',
      localPath: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/screenshot.png',
      sizeBytes: 276000,
    }],
  }];

  const [mapped] = mapDesktopMessagesForTranscript('session-1', messages);

  assert.deepEqual(mapped.attachments, [{
    kind: 'image',
    name: 'Screenshot 2026-04-30 10.59.00.png',
    formatLabel: 'PNG',
    previewUrl: null,
    mimeType: 'image/png',
    localPath: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/screenshot.png',
    sizeBytes: 276000,
  }]);
});
