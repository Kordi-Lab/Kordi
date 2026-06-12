import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildForwardDestinations, createForwardedMessageDraft, createForwardedMessageDrafts, orderedForwardSourcesForMessageIds, revealForwardedMessageInDestination } from '../src/features/chat/messageForwarding';
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

test('createForwardedMessageDrafts keeps multi-forward sources in input order and ignores caption', () => {
  const secondSource = { ...source, sourceMessageId: 'msg:second', senderLabel: 'Bob', textPreview: 'Second' };
  const drafts = createForwardedMessageDrafts({ sources: [source, secondSource], caption: 'ignored' });

  assert.deepEqual(drafts.map((draft) => draft.text), ['Forward this', 'Second']);
  assert.deepEqual(drafts.map((draft) => draft.messageAction.source.senderLabel), ['Alice', 'Bob']);
  assert.deepEqual(drafts.map((draft) => draft.messageAction.kind), ['forward', 'forward']);
});

test('orderedForwardSourcesForMessageIds returns selected sources in transcript order', () => {
  const first = { ...source, sourceMessageId: 'msg:first', textPreview: 'First' };
  const second = { ...source, sourceMessageId: 'msg:second', textPreview: 'Second' };
  const ordered = orderedForwardSourcesForMessageIds(['msg:first', 'msg:second'], new Map([
    ['msg:second', second],
    ['msg:first', first],
  ]));

  assert.deepEqual(ordered.map((entry) => entry.sourceMessageId), ['msg:first', 'msg:second']);
});

test('MessageForwardDialog renders destination picker and source preview', () => {
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source]}
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

test('MessageForwardDialog renders batch preview without caption field', () => {
  const secondSource = { ...source, sourceMessageId: 'msg:second', senderLabel: 'Bob', textPreview: 'Second' };
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source, secondSource]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /Forward 2 messages/);
  assert.match(markup, /data-message-forward-selected-preview="true"/);
  assert.match(markup, /Alice: Forward this/);
  assert.match(markup, /Bob: Second/);
  assert.doesNotMatch(markup, /Add a comment/);
});

test('MessageForwardDialog uses theme-safe shell classes and exposes forward mode', () => {
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /app-message-forward-dialog/);
  assert.match(markup, /data-message-forward-dialog="true"/);
  assert.match(markup, /data-message-forward-mode="single"/);
  assert.match(markup, /bg-\[color:var\(--app-modal-bg\)\]/);
  assert.doesNotMatch(markup, /bg-\[#101820\]/);
});
