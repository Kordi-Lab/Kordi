import assert from 'node:assert/strict';
import test from 'node:test';

import { createForwardedMessageDraft } from '../src/features/chat/messageForwarding';

const source = {
  sourceSessionId: 'session:one',
  sourceMessageId: 'msg:source',
  senderLabel: 'Alice',
  textPreview: 'Forward this',
  attachmentCount: 0,
  createdAtMs: null,
  timeLabel: '10:42',
};

test('createForwardedMessageDraft stores forwardedFrom metadata and text fallback', () => {
  const draft = createForwardedMessageDraft({ source, caption: '', destinationSessionId: 'session:two' });
  assert.equal(draft.text, 'Forward this');
  assert.equal(draft.messageAction.kind, 'forward');
  assert.deepEqual(draft.forwardedFrom, source);
});

test('createForwardedMessageDraft keeps user caption while preserving source metadata', () => {
  const draft = createForwardedMessageDraft({ source, caption: 'FYI', destinationSessionId: 'session:two' });
  assert.equal(draft.text, 'FYI');
  assert.equal(draft.messageAction.source.sourceMessageId, 'msg:source');
});
