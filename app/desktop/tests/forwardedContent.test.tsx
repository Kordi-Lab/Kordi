import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { forwardMessageSourceFromMessage } from '../src/features/chat/messageActionMetadata';
import { createForwardedMessageDraft } from '../src/features/chat/messageForwarding';
import { cloudMessageActionFromRecord } from '../src/features/cloud/cloudMessageActionCodec';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { canonicalMessageAction } from '../src/features/canonical/readModel/messageActionMapping';
import { MessageBubble, MessageContextMenuContent } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

const body = '## Complete answer\n\n**Important** and *useful*.\n\n- First\n- [x] Done\n\n> A quotation\n\n[Reference](https://example.com)\n\n| Name | Value |\n| --- | --- |\n| Item | One |\n\n```ts\nconst result = 42;\n```\n\n' + 'An intact paragraph. '.repeat(30) + '\n\nFinal line: @all \u4e2d\u6587 \u05e9\u05dc\u05d5\u05dd';
const message: Message = { id: 'original', role: 'owned-agent', sender: 'Research Agent', text: body, time: '10:00' };

function forward(caption = '') {
  return createForwardedMessageDraft({ source: forwardMessageSourceFromMessage(message, 'source')!, caption, destinationSessionId: 'destination' });
}

test('forward preserves the complete original body separately from the concise picker preview', () => {
  const source = forwardMessageSourceFromMessage(message, 'source')!;
  const draft = forward();
  assert.ok(source.textPreview.length <= 220);
  assert.equal(draft.text, body);
  assert.deepEqual(draft.messageAction.forwardedContent, { text: body });
  message.text = 'Edited later';
  assert.equal(draft.messageAction.forwardedContent?.text, body);
  message.text = body;
});

test('forward with a comment preserves both the comment and original across cloud and canonical codecs', () => {
  const draft = forward('Please review');
  assert.equal(draft.text, `Please review\n\n${body}`);
  for (const decode of [cloudMessageActionFromRecord, canonicalMessageAction]) {
    const action = decode(JSON.parse(JSON.stringify(draft.messageAction)))!;
    assert.deepEqual(action.forwardedContent, { text: body, comment: 'Please review' });
    const markup = renderToStaticMarkup(<MessageBubble msg={{ ...message, role: 'person', sender: 'Forwarder', text: draft.text, messageAction: action }} />);
    assert.match(markup, /Please review/);
    assert.match(markup, /data-markdown-heading="2"[^>]*>Complete answer<\/div>/);
    assert.match(markup, /<strong[^>]*>Important<\/strong>/);
    assert.match(markup, /<blockquote/);
    assert.match(markup, /<table/);
    assert.match(markup, /result = /);
    assert.match(markup, /Final line:/);
    assert.doesNotMatch(markup, /data-mention-identity=/);
    assert.equal(markup.split('Complete answer').length - 1, 1);
  }
});

test('forward takes only a completed visible agent answer, never thinking, tools or status text', () => {
  const turn = { assistantText: body, thinkingText: 'Private reasoning', completed: true, timeline: [{ text: 'Private tool details' }] } as unknown as NonNullable<Message['turn']>;
  const source = forwardMessageSourceFromMessage({ ...message, text: 'Status', detail: 'Internal status', turn }, 'source')!;
  const draft = createForwardedMessageDraft({ source, destinationSessionId: 'destination' });
  assert.equal(draft.text, body);
  assert.doesNotMatch(JSON.stringify(draft.messageAction), /Private reasoning|Private tool details|Internal status/);
  assert.equal(forwardMessageSourceFromMessage({ ...message, turn: { ...turn, completed: false } }, 'source'), null);
  assert.equal(forwardMessageSourceFromMessage({ ...message, text: 'Internal status', detail: 'Tool status', turn: { ...turn, assistantText: '' } }, 'source'), null);
  const attachmentOnly = forwardMessageSourceFromMessage({ ...message, text: 'Internal status', detail: 'Tool status', attachments: [{ kind: 'file', name: 'answer.txt' }], turn: { ...turn, assistantText: '' } }, 'source')!;
  assert.doesNotMatch(JSON.stringify(attachmentOnly), /Internal status|Tool status/);
});


test('legacy excerpt-only forwards remain readable with and without a comment', () => {
  const source = { sourceSessionId: 'missing-session', sourceMessageId: 'missing-source', senderLabel: 'Original author', textPreview: '**Available** excerpt', attachmentCount: 0 };
  for (const text of [source.textPreview, 'Legacy comment']) {
    const markup = renderToStaticMarkup(<MessageBubble msg={{ ...message, role: 'person', text, messageAction: { schemaVersion: 1, kind: 'forward', source } }} />);
    assert.match(markup, /<strong[^>]*>Available<\/strong>/);
    assert.equal(markup.split('Available').length - 1, 1);
    if (text === 'Legacy comment') assert.match(markup, /Legacy comment/);
  }
});

test('forwarded snapshots retain exact whitespace and discard unknown rendering metadata', () => {
  const action = forward().messageAction;
  for (const decode of [cloudMessageActionFromRecord, canonicalMessageAction]) {
    assert.deepEqual(decode({ ...action, forwardedContent: { text: '  line\r\n\r\nsecond  ', comment: 'Comment', tools: ['hidden'] } })?.forwardedContent, { text: '  line\r\n\r\nsecond  ', comment: 'Comment' });
    assert.equal(decode({ ...action, forwardedContent: { text: 42 } })?.forwardedContent, undefined);
    assert.equal(decode({ ...action, kind: 'quote' })?.forwardedContent, undefined);
  }
});


test('group transport preserves the full snapshot and optional comment without active mentions', () => {
  const draft = forward('Group comment');
  const actor = { accountId: 'acct_synthetic_forwarder', displayName: 'Forwarder', avatarUrl: null };
  const encoded = encodeCloudGroupControl({ kind: 'group-message', groupId: 'group:destination', groupTitle: 'Synthetic group', createdByAccountId: actor.accountId, actor, participants: [actor], message: { id: 'forwarded', senderAccountId: actor.accountId, createdAtMs: 1, text: draft.text, messageAction: draft.messageAction } });
  const received = parseCloudGroupControl(encoded)?.message;
  assert.equal(received?.text, `Group comment\n\n${body}`);
  assert.deepEqual(received?.messageAction?.forwardedContent, { text: body, comment: 'Group comment' });
  assert.equal(received?.mentions, undefined);
});

test('forwarded content uses the same renderer for own, peer and agent-attributed rows', () => {
  const draft = forward('Review');
  for (const role of ['person', 'user', 'owned-agent'] as const) {
    const markup = renderToStaticMarkup(<MessageBubble msg={{ ...message, role, isOwnMessage: role === 'user', text: draft.text, messageAction: draft.messageAction }} />);
    assert.match(markup, /app-forwarded-content/);
    assert.match(markup, /data-markdown-heading="2"/);
    assert.match(markup, /Final line:/);
    assert.equal(markup.split('Complete answer').length - 1, 1);
  }
});


test('immutable forwarded snapshots cannot offer an editor that only changes the outer body', () => {
  const action = forward('Comment').messageAction;
  const own: Message = { ...message, role: 'user', senderType: 'human', isOwnMessage: true, reactionConversationId: 'destination', reactionTargetMessageId: 'forwarded', cloudMessageVersion: 1 };
  const cases = [
    { action, editable: false },
    { action: { ...action, forwardedContent: undefined }, editable: true },
    { action: { ...action, kind: 'quote' as const, forwardedContent: undefined }, editable: true },
    { action: undefined, editable: true },
  ];
  for (const { action: messageAction, editable } of cases) {
    const markup = renderToStaticMarkup(<MessageContextMenuContent msg={{ ...own, messageAction }} onEditMessage={() => {}} onDeleteMessage={() => {}} onForwardMessage={() => {}} />);
    assert.equal(markup.includes('data-message-context-menu-action="edit"'), editable);
    assert.match(markup, /data-message-context-menu-action="delete"/);
    assert.match(markup, /data-message-context-menu-action="forward"/);
  }
});
