import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forwardMessageAction,
  messageActionPreviewText,
  messageActionSourceFromMessage,
  quoteMessageAction,
} from '../src/features/chat/messageActionMetadata';
import type { Message } from '../src/kordi-app/types/message';

const sourceMessage: Message = {
  id: 'msg:source',
  entryId: 'msg:source-entry',
  role: 'person',
  sender: 'Alice',
  senderType: 'human',
  text: 'Can we ship the concise version?',
  time: '10:42',
  attachments: [{ kind: 'file', name: 'brief.pdf' }],
};

test('messageActionSourceFromMessage captures stable quote source for model-readable metadata', () => {
  const source = messageActionSourceFromMessage(sourceMessage, 'session:group:one');
  assert.deepEqual(source, {
    sourceSessionId: 'session:group:one',
    sourceMessageId: 'msg:source',
    sourceMessageKind: 'text',
    senderLabel: 'Alice',
    textPreview: 'Can we ship the concise version?',
    attachmentCount: 1,
    timeLabel: '10:42',
    createdAtMs: null,
  });
});

test('quoteMessageAction and forwardMessageAction create schema-versioned metadata', () => {
  const source = messageActionSourceFromMessage(sourceMessage, 'session:group:one');
  assert.ok(source);
  assert.equal(quoteMessageAction(source).kind, 'quote');
  assert.equal(forwardMessageAction(source).kind, 'forward');
  assert.equal(quoteMessageAction(source).schemaVersion, 1);
});

test('messageActionPreviewText prefers assistant text and truncates multi-line text', () => {
  const preview = messageActionPreviewText(
    {
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '',
      time: '10:43',
      turn: {
        id: 'turn:1',
        sessionId: 'session:one',
        prompt: '',
        status: 'complete',
        message: 'Complete',
        assistantText: 'Line one\nLine two with extra text',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
      },
    },
    16,
  );
  assert.equal(preview, 'Line one Line t…');
});
