import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildForwardDestinations, createForwardedMessageDraft, revealForwardedMessageInDestination } from '../src/features/chat/messageForwarding';
import { MessageForwardDialog } from '../src/pages/MessageForwardDialog';

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

test('buildForwardDestinations exposes dense selectable chat labels', () => {
  const destinations = buildForwardDestinations([
    { id: 'local-draft-chat', name: 'Draft', type: 'person', subtitle: '', unread: 0, bridges: [], trust: '', directness: '', participants: [], messages: [] },
    { id: 'conv:one', canonicalSessionId: 'session:one', name: 'Alice', type: 'person', subtitle: 'Direct', unread: 0, bridges: [], trust: '', directness: '', participants: [], messages: [] },
    { id: 'conv:two', canonicalSessionId: 'session:two', name: 'Group', type: 'person', subtitle: '3 members', unread: 0, bridges: [], trust: '', directness: '', participants: [], messages: [] },
  ], 'local-draft-chat');

  assert.deepEqual(destinations.map((destination) => destination.id), ['session:one', 'session:two']);
  assert.equal(destinations[0].label, 'Alice');
  assert.equal(destinations[0].conversationId, 'conv:one');
  assert.equal(destinations[1].subtitle, '3 members');
});

test('revealForwardedMessageInDestination selects destination before revealing forwarded message', () => {
  const calls: string[] = [];

  revealForwardedMessageInDestination({
    destinationConversationId: 'session:two',
    forwardedMessageId: 'msg:forwarded',
    setActiveConversationId: (id) => calls.push(`select:${id}`),
    revealMessage: (id) => calls.push(`reveal:${id}`),
    defer: (callback) => {
      calls.push('defer');
      callback();
    },
  });

  assert.deepEqual(calls, ['select:session:two', 'defer', 'reveal:msg:forwarded']);
});

test('revealForwardedMessageInDestination can switch and fall back to bottom for direct cloud forwards', () => {
  const calls: string[] = [];

  revealForwardedMessageInDestination({
    destinationConversationId: 'bridge:cloud-person:peer',
    forwardedMessageId: null,
    setActiveConversationId: (id) => calls.push(`select:${id}`),
    revealMessage: (id) => calls.push(`reveal:${id}`),
    revealLatest: () => calls.push('latest'),
    defer: (callback) => callback(),
  });

  assert.deepEqual(calls, ['select:bridge:cloud-person:peer', 'latest']);
});

test('MessageForwardDialog renders destination picker and source preview', () => {
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      source={source}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /Forward message/);
  assert.match(markup, /data-message-forward-destination="session:two"/);
  assert.match(markup, /Alice: Forward this/);
});
