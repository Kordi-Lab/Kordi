import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forwardMessageSourceFromMessage,
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

test('reply and forward source metadata retains mention identity after preview normalization', () => {
  const displayText = "@Alex Smith’s Kordi";
  const source = messageActionSourceFromMessage({
    ...sourceMessage,
    text: `${displayText}\nplease review`,
    mentions: [{
      label: 'AlexSmithsKordi',
      targetKind: 'agent',
      targetIdentityId: 'agent:cloud_agent_alex',
      startUtf16: 0,
      lengthUtf16: displayText.length,
      displayText,
    }],
  }, 'session:group:one');

  assert.equal(source?.textPreview, `${displayText} please review`);
  assert.deepEqual(source?.mentions?.[0], {
    label: 'AlexSmithsKordi',
    targetKind: 'agent',
    targetIdentityId: 'agent:cloud_agent_alex',
    startUtf16: 0,
    lengthUtf16: displayText.length,
    displayText,
    sourceHostId: null,
    nodeId: null,
    humanId: null,
    agentId: null,
    displayLabel: null,
  });
  assert.deepEqual(quoteMessageAction(source!).source.mentions, source?.mentions);
  assert.deepEqual(forwardMessageAction(source!).source.mentions, source?.mentions);
});

test('forwardMessageSourceFromMessage keeps attachments transient while persisted actions omit local paths', () => {
  const message: Message = {
    ...sourceMessage,
    text: '',
    attachments: [{
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      localPath: '/tmp/private/screen.png',
      attachmentId: 'att_screen',
    }],
  };
  const source = forwardMessageSourceFromMessage(message, 'session:group:one');

  assert.ok(source);
  assert.equal(source.attachmentOnly, true);
  assert.equal(source.attachments[0]?.localPath, '/tmp/private/screen.png');
  const action = forwardMessageAction(source);
  assert.equal('attachments' in action.source, false);
  assert.equal('attachmentOnly' in action.source, false);
  assert.doesNotMatch(JSON.stringify(action), /\/tmp\/private/);
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

test('messageActionPreviewText identifies attachment-only reply targets', () => {
  const cases: Array<[Message['attachments'], Message['messageKind'], string]> = [
    [[{ kind: 'image', name: 'photo.png', mimeType: 'image/png' }], undefined, 'Photo'],
    [[{ kind: 'file', name: 'clip.mp4', mimeType: 'video/mp4' }], undefined, 'Video'],
    [[{ kind: 'image', subtype: 'sticker', name: 'wave.png' }], 'sticker', 'Sticker'],
    [[{ kind: 'image', name: 'dance.gif', mimeType: 'image/gif' }], undefined, 'GIF'],
    [[{ kind: 'file', name: 'brief.pdf', mimeType: 'application/pdf' }], undefined, 'brief.pdf'],
  ];

  for (const [attachments, messageKind, expected] of cases) {
    assert.equal(messageActionPreviewText({ text: '', attachments, messageKind }), expected);
  }
});
