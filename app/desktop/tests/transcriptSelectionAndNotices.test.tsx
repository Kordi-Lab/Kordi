import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PinActivityNotice, PinMessageDialog, PinnedMessageBar } from '../src/pages/ChatsPage';
import { MessageBubble, MessageContextMenuContent, messageContextMenuPosition } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

test('multi-pin shelf is folded by default and single pins keep their controls visible', () => {
  const message: Message = {
    id: 'msg:pinned-bar',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Pinned message body',
    time: '10:42',
  };
  const multiMarkup = renderToStaticMarkup(createElement(PinnedMessageBar, {
    items: [
      { message, scope: 'private' },
      { message: { ...message, id: 'msg:shared', text: 'Shared pinned body' }, scope: 'shared' },
    ],
    onOpenMessage: () => undefined,
    onRequestUnpin: () => undefined,
  }));

  assert.match(multiMarkup, /data-pinned-message-bar="true"/);
  assert.match(multiMarkup, /data-pinned-message-count="2"/);
  assert.match(multiMarkup, /data-pinned-message-expanded="false"/);
  assert.match(multiMarkup, /aria-expanded="false"/);
  assert.match(multiMarkup, /2 pinned messages/);
  assert.doesNotMatch(multiMarkup, /Only you|Everyone|Pinned message body|Shared pinned body/);

  const singleMarkup = renderToStaticMarkup(createElement(PinnedMessageBar, {
    items: [{ message, scope: 'private' }],
    onOpenMessage: () => undefined,
    onRequestUnpin: () => undefined,
  }));
  assert.match(singleMarkup, /data-pinned-message-expanded="true"/);
  assert.doesNotMatch(singleMarkup, />Only you<|>Everyone</);
  assert.match(singleMarkup, /Alice: Pinned message body/);
  assert.match(singleMarkup, /aria-label="Unpin message pinned only for you"/);
});

test('pin activity uses the transcript system-notice treatment', () => {
  const markup = renderToStaticMarkup(createElement(PinActivityNotice, {
    label: 'Alice unpinned a message',
  }));

  assert.match(markup, /data-pin-activity="true"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /app-system-notice-text/);
  assert.match(markup, /Alice unpinned a message/);
});

test('pin and unpin confirmation dialogs use compact clear copy', () => {
  const message: Message = {
    id: 'msg:pin-dialog',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Pin me',
    time: '10:42',
  };
  const pinMarkup = renderToStaticMarkup(createElement(PinMessageDialog, {
    mode: 'pin',
    message,
    pinForEveryone: false,
    onTogglePinForEveryone: () => undefined,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  }));
  const unpinMarkup = renderToStaticMarkup(createElement(PinMessageDialog, {
    mode: 'unpin',
    message,
    pinForEveryone: false,
    onTogglePinForEveryone: () => undefined,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(pinMarkup, /Pin this message\?/);
  assert.match(pinMarkup, /Pin for everyone/);
  assert.doesNotMatch(pinMarkup, /super/i);
  assert.match(pinMarkup, /max-w-\[28rem\]/);
  assert.match(pinMarkup, /text-\[15px\]/);
  assert.match(pinMarkup, /text-\[14px\]/);
  assert.match(pinMarkup, />Cancel</);
  assert.match(pinMarkup, />Pin</);
  assert.match(unpinMarkup, /Unpin this message\?/);
  assert.doesNotMatch(unpinMarkup, /Pin for everyone/);
  assert.match(unpinMarkup, />Unpin</);
});

test('message bubble exposes a non-text drag-select handle before selection mode starts', () => {
  const message: Message = {
    id: 'msg-drag-start',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Drag beside this message, not over text',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    isMessageSelectable: () => true,
    onSelectionDragStart: () => undefined,
    onSelectionDragEnter: () => undefined,
    onSelectionDragEnd: () => undefined,
  }));

  assert.match(markup, /data-message-selection-drag-handle="msg-drag-start"/);
  assert.match(markup, /data-message-selection-drag-state="idle"/);
  assert.match(markup, /aria-label="Drag to select message from Alice at 10:42"/);
});

test('message bubble renders selected check control in selection mode', () => {
  const message: Message = {
    id: 'msg-selected',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Selected text',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    selectionMode: true,
    selectedMessageIds: new Set(['msg-selected']),
    isMessageSelectable: () => true,
    onToggleSelectedMessage: () => undefined,
  }));

  assert.match(markup, /data-message-selection-control="msg-selected"/);
  assert.match(markup, /data-message-selection-draggable="true"/);
  assert.match(markup, /data-message-selection-state="selected"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /Deselect message from Alice at 10:42/);
});

test('message context menu installs document-level outside dismissal listeners', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');

  assert.match(source, /document\.addEventListener\('pointerdown'/);
  assert.match(source, /document\.addEventListener\('contextmenu'/);
  assert.match(source, /document\.addEventListener\('keydown'/);
  assert.match(source, /menuRef\.current\.contains\(target\)/);
});

test('message context menu position stays close to the clicked message rectangle', () => {
  const below = messageContextMenuPosition({
    clientX: 340,
    clientY: 130,
    targetRect: { left: 260, right: 420, top: 90, bottom: 148 },
    viewportWidth: 900,
    viewportHeight: 700,
  });
  const above = messageContextMenuPosition({
    clientX: 340,
    clientY: 620,
    targetRect: { left: 260, right: 420, top: 590, bottom: 650 },
    viewportWidth: 900,
    viewportHeight: 700,
  });
  const measuredAbove = messageContextMenuPosition({
    clientX: 340,
    clientY: 620,
    targetRect: { left: 260, right: 420, top: 590, bottom: 650 },
    viewportWidth: 900,
    viewportHeight: 700,
    menuHeight: 408,
  });

  assert.equal(below.y, 150);
  assert.equal(above.y, 302);
  assert.equal(measuredAbove.y, 206);
});

test('messages without read receipts still expose the Telegram-style message context menu', () => {
  const message: Message = {
    id: 'msg:no-read-receipts-menu',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    isOwnMessage: false,
    text: 'hello',
    time: '00:45',
  };

  const bubbleMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  const menuMarkup = renderToStaticMarkup(createElement(MessageContextMenuContent, { msg: message }));

  assert.match(bubbleMarkup, /data-message-context-menu-target="true"/);
  assert.match(bubbleMarkup, /data-message-context-menu-anchor="true"/);
  assert.doesNotMatch(bubbleMarkup, /data-message-read-receipts-context-target/);
  assert.match(menuMarkup, /Copy Text/);
  assert.match(menuMarkup, /Reply/);
  assert.doesNotMatch(menuMarkup, /Seen/);
});

test('agent turn messages also expose the Telegram-style message context menu target', () => {
  const message: Message = {
    role: 'owned-agent',
    sender: 'My Kordi',
    senderType: 'agent',
    text: '',
    time: '00:45',
    turn: {
      id: 'turn-menu',
      sessionId: 'session-1',
      prompt: 'hello',
      status: 'completed',
      message: '',
      assistantText: 'Done.',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: true,
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /data-message-context-menu-target="true"/);
});

test('own group message suppresses read footer when read count is zero', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello group',
    time: '00:45',
    statusChips: ['delivered'],
    readReceiptSummary: {
      count: 0,
      participants: [],
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.doesNotMatch(markup, /app-message-read-receipts/);
  assert.doesNotMatch(markup, /Read by 0/);
  assert.match(markup, /data-message-delivery-glyph="single-check"/);
});

test('blank outgoing delivery status still renders the stable hidden glyph stack', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello',
    time: '00:45',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-message-delivery-footer ml-3/);
  assert.match(markup, /data-message-delivery-status="none"/);
  assert.match(markup, /data-message-delivery-glyph="none"/);
  assert.match(markup, /data-message-delivery-glyph="none" aria-hidden="true"/);
  assert.doesNotMatch(markup, /aria-label="Sent"/);
  assert.match(markup, /lucide-check[^\"]*opacity-0/);
  assert.match(markup, /lucide-check-check[^\"]*opacity-0/);
});

test('exact message time moves beside the bubble while delivery state stays inside', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hover for the exact time',
    time: '20:25',
    timestampMs: Date.parse('2026-08-04T20:25:00.000Z'),
    statusChips: ['read'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  const footerStart = markup.indexOf('app-message-footer');
  const hoverTimeStart = markup.indexOf('app-message-hover-time pointer-events-none');

  assert.ok(footerStart >= 0);
  assert.ok(hoverTimeStart > footerStart);
  assert.doesNotMatch(markup.slice(footerStart, hoverTimeStart), /20:25/);
  assert.match(markup.slice(hoverTimeStart), />20:25<\/time>/);
  assert.match(markup, /app-message-hover-time-trigger/);
  assert.doesNotMatch(markup, /group-hover\/message:opacity-100/);
  assert.match(markup, /data-message-delivery-glyph="double-check"/);
});

test('blank transcript-row space does not reveal the exact message time', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/styles/shell-transcript.css', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /group\/message/);
  assert.match(source, /app-message-hover-time-trigger/);
  assert.match(styles, /\.app-message-hover-time-trigger:is\(:hover, :focus-within\) \+ \.app-message-hover-time/);
});

test('short agent messages shrink-wrap the row so hover time stays beside the bubble', () => {
  const message: Message = {
    role: 'assistant',
    sender: 'My Kordi',
    senderType: 'agent',
    text: 'Hi hi hi. What’s up?',
    time: '19:59',
    timestampMs: Date.parse('2026-08-08T19:59:00.000Z'),
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /flex items-end w-fit max-w-full gap-2/);
  assert.doesNotMatch(markup, /flex items-end w-full gap-2/);
  assert.match(markup, /app-message-hover-time/);
});

test('renders contact-gated failed sends as a centered notice instead of changing the message bubble', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello again',
    time: '00:45',
    detail: 'Send a contact request before messages can be delivered.',
    statusChips: ['failed'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    onRequestCollaborationContact: async () => undefined,
  }));

  assert.match(markup, /app-contact-request-failure-notice/);
  assert.match(markup, /self-center/);
  assert.doesNotMatch(markup, /self-start/);
  assert.match(markup, />Message not delivered\.</);
  assert.match(markup, />Send contact request</);
  assert.doesNotMatch(markup, />Send a contact request before messages can be delivered\.</);
  assert.doesNotMatch(markup, /Messages are blocked until this person approves you/);

  const bubbleStart = markup.indexOf('app-chat-bubble-user');
  const noticeStart = markup.indexOf('app-contact-request-failure-notice');
  assert.ok(bubbleStart >= 0);
  assert.ok(noticeStart > bubbleStart);
  assert.doesNotMatch(markup.slice(bubbleStart, noticeStart), /Send a contact request before messages can be delivered/);
});

test('renders pending contact request failures with the same explicit request action', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello again',
    time: '00:45',
    detail: 'Contact request is pending. They need to approve it before messages can be delivered.',
    statusChips: ['failed'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    onRequestCollaborationContact: async () => undefined,
  }));

  assert.match(markup, />Message not delivered\.</);
  assert.match(markup, />Send contact request</);
  assert.doesNotMatch(markup, />Contact request is pending\. They need to approve it before messages can be delivered\.</);
});
