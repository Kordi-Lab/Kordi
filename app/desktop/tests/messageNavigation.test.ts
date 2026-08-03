import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveTranscriptMessageIdForSource } from '../src/features/chat/messageNavigation';
import type { Message, MessageSourceReference } from '../src/kordi-app/types';

const visibleForwardedMessage: Message = {
  id: 'visible-cloud-message-333',
  role: 'person',
  sender: '333',
  senderType: 'human',
  isOwnMessage: false,
  messageAction: {
    schemaVersion: 1,
    kind: 'forward',
    source: {
      sourceSessionId: 'source-session-111',
      sourceMessageId: 'remote-source-message-111',
      senderLabel: '111',
      textPreview: 'I’m an OpenAI assistant running in ChatGPT-style API infrastructure.',
      attachmentCount: 0,
      createdAtMs: null,
      timeLabel: '13:56',
    },
  },
  text: 'I’m an OpenAI assistant running in ChatGPT-style API infrastructure. I don’t always get visibility into the exact model name.',
  time: '13:56',
};

const quotedSourceWithRemoteId: MessageSourceReference = {
  messageId: 'remote-source-message-111',
  senderLabel: '333',
  text: 'I’m an OpenAI assistant running in ChatGPT-style API infrastructure. I don’t always get visibility into the exact model name.',
  attachmentCount: 0,
};

test('resolveTranscriptMessageIdForSource prefers exact visible ids when they are mounted in the transcript', () => {
  const exactMessage: Message = {
    ...visibleForwardedMessage,
    id: 'exact-source-message',
    text: 'Different text with the exact id',
  };

  const resolved = resolveTranscriptMessageIdForSource({ ...quotedSourceWithRemoteId, messageId: 'exact-source-message' }, [
    visibleForwardedMessage,
    exactMessage,
  ]);

  assert.equal(resolved, 'exact-source-message');
});

test('resolveTranscriptMessageIdForSource can jump to a quoted peer forwarded message when the Cloud source id differs from the visible row id', () => {
  const resolved = resolveTranscriptMessageIdForSource(quotedSourceWithRemoteId, [visibleForwardedMessage]);

  assert.equal(resolved, 'visible-cloud-message-333');
});

test('resolveTranscriptMessageIdForSource keeps the requested id when no visible transcript message matches', () => {
  const resolved = resolveTranscriptMessageIdForSource({ ...quotedSourceWithRemoteId, text: 'unmatched text' }, [visibleForwardedMessage]);

  assert.equal(resolved, 'remote-source-message-111');
});

test('resolveTranscriptMessageIdForSource maps a persisted reply alias to the visible outgoing message', () => {
  const visibleOwnMessage: Message = {
    id: 'visible-own-message',
    replyAliasIds: ['persisted-request-alias'],
    role: 'user',
    sender: 'Shu Yang',
    senderType: 'human',
    isOwnMessage: true,
    text: '@CUFishAIsKordi ask anything to my Kordi',
    time: '16:57',
  };

  const resolved = resolveTranscriptMessageIdForSource({
    messageId: 'persisted-request-alias',
    senderLabel: 'Me',
    text: visibleOwnMessage.text,
    attachmentCount: 0,
  }, [visibleOwnMessage]);

  assert.equal(resolved, 'visible-own-message');
});

test('resolveTranscriptMessageIdForSource treats Me as the visible local sender when ids changed', () => {
  const visibleOwnMessage: Message = {
    id: 'visible-own-message',
    role: 'user',
    sender: 'Shu Yang',
    senderType: 'human',
    isOwnMessage: true,
    text: '@CUFishAIsKordi ask anything to my Kordi',
    time: '16:57',
  };

  const resolved = resolveTranscriptMessageIdForSource({
    messageId: 'stale-source-message-id',
    senderLabel: 'Me',
    text: visibleOwnMessage.text,
    attachmentCount: 0,
  }, [visibleOwnMessage]);

  assert.equal(resolved, 'visible-own-message');
});
