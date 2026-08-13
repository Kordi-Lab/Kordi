import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveTranscriptMessageIdForSource,
  resolveTranscriptNavigationIdsForSource,
} from '../src/features/chat/messageNavigation';
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

test('reply navigation retains the complete identity chain from the reproduced Cloud request', () => {
  const canonicalRequestId = 'msg:ui:ceebb3d7-edcf-4643-8624-d5807abdf3a8';
  const outgoingRequest: Message = {
    id: canonicalRequestId,
    entryId: canonicalRequestId,
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@ResearchAgentsKordi  ask anything to my kordi',
    time: '20:45',
  };

  const resolved = resolveTranscriptNavigationIdsForSource({
    messageId: canonicalRequestId,
    senderLabel: 'Me',
    text: outgoingRequest.text,
    attachmentCount: 0,
    time: outgoingRequest.time,
  }, [outgoingRequest]);

  assert.equal(resolved.id, canonicalRequestId);
  assert.deepEqual(resolved.lookupIds, [canonicalRequestId]);
});

test('reply navigation maps persisted aliases and relative sender labels to the visible outgoing row', () => {
  const outgoingRequest: Message = {
    id: 'runtime-entry-visible',
    entryId: 'runtime-entry-visible',
    replyAliasIds: ['msg:ui:persisted-request', 'bridge-request-alias'],
    role: 'user',
    sender: 'Alex Morgan',
    senderType: 'human',
    isOwnMessage: true,
    text: '@ResearchAgentsKordi ask anything to my kordi',
    time: '16:57',
  };

  const resolved = resolveTranscriptNavigationIdsForSource({
    messageId: 'msg:ui:persisted-request',
    senderLabel: 'Me',
    text: outgoingRequest.text,
    attachmentCount: 0,
    time: outgoingRequest.time,
  }, [outgoingRequest]);

  assert.equal(resolved.id, 'runtime-entry-visible');
  assert.deepEqual(resolved.lookupIds, [
    'msg:ui:persisted-request',
    'runtime-entry-visible',
    'bridge-request-alias',
  ]);
});

test('reply navigation treats Me as the local sender when a legacy source id changed', () => {
  const outgoingRequest: Message = {
    id: 'visible-own-message',
    role: 'user',
    sender: 'Alex Morgan',
    senderType: 'human',
    isOwnMessage: true,
    text: '@ResearchAgentsKordi ask anything to my kordi',
    time: '16:57',
  };

  const resolved = resolveTranscriptNavigationIdsForSource({
    messageId: 'stale-source-message-id',
    senderLabel: 'Me',
    text: outgoingRequest.text,
    attachmentCount: 0,
    time: '16:58',
  }, [outgoingRequest]);

  assert.equal(resolved.id, 'visible-own-message');
  assert.deepEqual(resolved.lookupIds, [
    'stale-source-message-id',
    'visible-own-message',
  ]);
});

test('reply navigation does not redirect an ambiguous legacy text match', () => {
  const duplicate = (id: string): Message => ({
    id,
    role: 'user',
    sender: 'Alex Morgan',
    senderType: 'human',
    isOwnMessage: true,
    text: 'same request',
    time: '10:00',
  });

  const resolved = resolveTranscriptNavigationIdsForSource({
    messageId: 'missing-legacy-id',
    senderLabel: 'Me',
    text: 'same request',
    attachmentCount: 0,
    time: '10:00',
  }, [duplicate('first'), duplicate('second')]);

  assert.equal(resolved.id, 'missing-legacy-id');
  assert.deepEqual(resolved.lookupIds, ['missing-legacy-id']);
});
