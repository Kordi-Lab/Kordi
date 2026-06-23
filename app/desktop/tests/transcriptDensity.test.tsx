import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PinMessageDialog, PinnedMessageBar } from '../src/pages/ChatsPage';
import { ContactRequestRow, LiveChatTurnCard, MessageBubble, MessageContextMenuContent, messageContextMenuPosition } from '../src/kordi-app/components/transcript';
import type { ContactRequest, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('renders live turn errors as raw red inline text instead of a popped bubble', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-error',
    sessionId: 'session-1',
    prompt: 'hello',
    status: 'failed',
    message: '',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: false,
    error: 'ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again, or switch this provider to an OpenAI API key.',
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.match(markup, /app-live-turn-error app-live-turn-error-text/);
  assert.match(markup, /text-\[12px\]/);
  assert.doesNotMatch(markup, /rounded-\[14px\]/);
  assert.doesNotMatch(markup, /border-rose-500/);
  assert.doesNotMatch(markup, /bg-rose-500/);
  assert.doesNotMatch(markup, /circle-alert/);
});

test('no-provider failed agent turn renders red inline text with authentication action', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-no-provider',
    sessionId: 'session-1',
    prompt: 'hello',
    status: 'failed',
    message: 'Failed',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: false,
    error: 'No provider configured yet.',
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn,
    historical: true,
    onOpenAuthSettings: () => undefined,
  }));

  assert.match(markup, /app-live-turn-error app-live-turn-error-text/);
  assert.match(markup, /text-rose-300/);
  assert.match(markup, /No provider configured yet/);
  assert.match(markup, />Open authentication</);
  assert.match(markup, /app-live-turn-auth-action/);
  assert.match(markup, /whitespace-nowrap/);
  assert.match(markup, /underline/);
  assert.doesNotMatch(markup, /rounded-full border border-rose/);
});

test('unknown-model provider failures render as the compact authentication notice', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-unknown-model',
    sessionId: 'session-1',
    prompt: '@MyKordi what are you doing',
    status: 'failed',
    message: 'Failed',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: false,
    error: 'Unknown model: openai/gpt-5.4',
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn,
    historical: true,
    onOpenAuthSettings: () => undefined,
  }));

  assert.match(markup, /No provider configured yet/);
  assert.match(markup, />Open authentication</);
  assert.doesNotMatch(markup, /Unknown model: openai\/gpt-5\.4/);
});

test('no-provider live turn keeps the source quote so reply context stays stable', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-no-provider-source',
    sessionId: 'session-1',
    prompt: '@MyKordi what are you doing',
    status: 'failed',
    message: 'Failed',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: false,
    error: 'No provider configured yet.',
    sourceMessage: {
      messageId: 'msg:request',
      senderLabel: 'Me',
      text: '@MyKordi what are you doing',
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn,
    historical: true,
    onOpenAuthSettings: () => undefined,
  }));

  assert.match(markup, /No provider configured yet/);
  assert.match(markup, />Open authentication</);
  assert.match(markup, /app-source-message-quote/);
  assert.match(markup, /app-live-assistant-answer-surface/);
  assert.match(markup, /@MyKordi what are you doing/);
});

test('contact request row shows accept progress while sending the greeting', () => {
  const request: ContactRequest = {
    id: 'request-1',
    initials: 'TU',
    title: 'Testuser4 wants to connect',
    detail: "I am Testuser4. I'd like to add you as a Kordi contact.",
    time: 'now',
  };

  const markup = renderToStaticMarkup(createElement(ContactRequestRow, {
    request,
    active: false,
    onReview: () => undefined,
    onAccept: () => undefined,
    onReject: () => undefined,
    actionState: 'accepting',
  }));

  assert.match(markup, />Accepting…</);
  assert.match(markup, />Accepting and sending greeting…</);
  assert.match(markup, /animate-spin/);
  assert.match(markup, /disabled=""/);
});

test('renders bridge agent stop control beside pending processing text', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-pending-bridge-agent',
    sessionId: 'session-1',
    prompt: '',
    status: 'processing',
    message: 'Processing…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
    pendingBridgeAgentRequest: {
      conversationId: 'bridge:host-1:node-agent',
      requestId: 'bridge_req_stop',
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn,
    onStopBridgeAgentRequest: () => undefined,
  }));

  assert.match(markup, /aria-label="Stop agent request"/);
  assert.match(markup, /title="Stop agent request"/);
  assert.match(markup, /app-bridge-agent-stop-button/);
  assert.match(markup, /h-\[18px\] w-\[18px\]/);
  assert.match(markup, /text-slate-400/);
  assert.doesNotMatch(markup, /h-5\.5 w-5\.5/);
  assert.match(markup, /Processing/);
});

test('empty pending agent turn renders processing with its source quote', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-pending-source-delay',
    sessionId: 'session-1',
    prompt: '@MyKordi what are you doing',
    status: 'starting',
    message: 'Working…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
    sourceMessage: {
      messageId: 'msg:request',
      senderLabel: 'Me',
      text: '@MyKordi what are you doing',
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn }));

  assert.match(markup, /app-source-message-quote/);
  assert.match(markup, /@MyKordi what are you doing/);
  assert.match(markup, /Starting…/);
});

test('renders initial generic working status as starting until a real tool phase appears', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-starting-work',
    sessionId: 'session-1',
    prompt: '@Kordi plan the website choices',
    status: 'starting',
    message: 'Working…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
    sourceMessage: {
      messageId: 'msg:request',
      senderLabel: 'Me',
      text: '@Kordi plan the website choices',
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn }));

  assert.match(markup, /Starting…/);
  assert.doesNotMatch(markup, /Planning…/);
  assert.doesNotMatch(markup, /Working…/);
});

test('image-only human messages use compact frosted attachment padding', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '',
    time: '21:09',
    attachments: [{
      kind: 'image',
      name: 'Screenshot 2026-05-20.png',
      previewUrl: 'https://files.test/preview.png',
      mimeType: 'image/png',
    }],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /max-w-\[31rem\]/);
  assert.match(markup, /p-0/);
  assert.match(markup, /bg-transparent/);
  assert.match(markup, /shadow-none/);
  assert.doesNotMatch(markup, /app-message-bubble-shape/);
  assert.doesNotMatch(markup, /app-message-footer/);
  assert.doesNotMatch(markup, /px-4 py-2\.5/);
});

test('renders failed own message delivery as a compact red exclamation', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@Testuser3sKordi can you see our chat history ?',
    time: '00:45',
    statusChips: ['failed'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.doesNotMatch(markup, />Sending failed</);
  assert.match(markup, />!<\/span>/);
  assert.match(markup, /text-rose-400/);
});

test('forwarded human messages render Telegram-style forwarded header instead of quote block', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'Forward this',
    time: '12:18',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:one',
        sourceMessageId: 'msg:source',
        senderLabel: 'Shiney lala',
        textPreview: 'Original text',
        attachmentCount: 0,
        timeLabel: '12:07',
      },
    },
    sourceMessage: {
      messageId: 'msg:source',
      senderLabel: 'Shiney lala',
      text: 'Original text',
      attachmentCount: 0,
      time: '12:07',
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /data-message-forwarded-header="true"/);
  assert.match(markup, />Forwarded from</);
  assert.match(markup, />Shiney lala</);
  assert.doesNotMatch(markup, /app-source-message-quote/);
});

test('quoted human messages still render source quote instead of forwarded header', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'Replying',
    time: '12:18',
    messageAction: {
      schemaVersion: 1,
      kind: 'quote',
      source: {
        sourceSessionId: 'session:one',
        sourceMessageId: 'msg:source',
        senderLabel: 'Alice',
        textPreview: 'Original text',
        attachmentCount: 0,
        timeLabel: '12:07',
      },
    },
    sourceMessage: {
      messageId: 'msg:source',
      senderLabel: 'Alice',
      text: 'Original text',
      attachmentCount: 0,
      time: '12:07',
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-source-message-quote/);
  assert.doesNotMatch(markup, /data-message-forwarded-header="true"/);
});

test('forwarded message reveal uses reduced-motion-safe highlight styling', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-message-forward-reveal/);
  assert.match(shellCss, /@keyframes\s+app-message-forward-reveal/);
  assert.match(shellCss, /prefers-reduced-motion:\s*reduce[\s\S]*\.app-message-forward-reveal[\s\S]*animation:\s*none/);
});

test('sent-message delivery glyph keeps one stable slot so status changes do not refresh the whole popover', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello',
    time: '00:45',
    statusChips: ['sent'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-message-delivery-footer ml-3/);
  assert.match(markup, /min-w-\[2\.1rem\]/);
  assert.doesNotMatch(markup, /right-0/);
  assert.doesNotMatch(markup, /pr-\[3\.75rem\]/);
  assert.doesNotMatch(markup, /pb-4/);
  assert.match(markup, /data-message-delivery-status="sent"/);
  assert.match(markup, /data-message-delivery-glyph="single-check"/);
  assert.match(markup, /aria-label="Sent"/);
  assert.match(markup, /opacity-100[^\"]*text-slate-400/);
  assert.match(markup, /opacity-0[^\"]*text-slate-400/);
  assert.doesNotMatch(markup, /app-message-delivery-clock-active/);
  assert.doesNotMatch(markup, /title="Sent"/);
});

test('sending own message renders a Telegram-style clock with moving hands in the stable delivery slot', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello',
    time: '00:45',
    statusChips: ['sending'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-message-delivery-footer ml-3/);
  assert.match(markup, /data-message-delivery-status="sending"/);
  assert.match(markup, /data-message-delivery-glyph="clock"/);
  assert.match(markup, /aria-label="Sending"/);
  assert.match(markup, /app-message-delivery-clock-active/);
  assert.match(markup, /app-message-delivery-clock-face/);
  assert.match(markup, /app-message-delivery-clock-hour-hand/);
  assert.match(markup, /app-message-delivery-clock-minute-hand/);
  assert.doesNotMatch(markup, /animate-pulse/);
  assert.doesNotMatch(markup, /lucide-loader-circle[^>]*animate-spin/);
});

test('sending clock hand motion is CSS-driven and reduced-motion safe', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /@keyframes\s+app-message-delivery-clock-minute/);
  assert.match(shellCss, /@keyframes\s+app-message-delivery-clock-hour/);
  assert.match(shellCss, /\.app-message-delivery-clock-active\s+\.app-message-delivery-clock-minute-hand\s*{[^}]*animation:\s*app-message-delivery-clock-minute/s);
  assert.match(shellCss, /\.app-message-delivery-clock-active\s+\.app-message-delivery-clock-hour-hand\s*{[^}]*animation:\s*app-message-delivery-clock-hour/s);
  assert.match(shellCss, /prefers-reduced-motion:\s*reduce[\s\S]*\.app-message-delivery-clock-active[\s\S]*animation:\s*none/);
});

test('own agent-session request uses double check only after response is marked responded', () => {
  const sentMessage: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@My Kordi summarize this',
    time: '00:45',
    statusChips: ['sent'],
  };
  const respondedMessage: Message = {
    ...sentMessage,
    statusChips: ['responded'],
  };

  const sentMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: sentMessage }));
  const respondedMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: respondedMessage }));

  assert.match(sentMarkup, /data-message-delivery-glyph="single-check"/);
  assert.match(respondedMarkup, /data-message-delivery-glyph="double-check"/);
});

test('own group read receipts are not shown inline and are available from the message context menu', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello group',
    time: '00:45',
    statusChips: ['read'],
    readReceiptSummary: {
      count: 2,
      participants: [
        { id: 'human:acct_a', name: 'Alice', avatarSeed: 'cloud:acct_a', profileImageUrl: null, readAt: '2026-06-06T12:00:02Z' },
        { id: 'human:acct_b', name: 'Bob', avatarSeed: 'cloud:acct_b', profileImageUrl: null, readAt: '2026-06-06T12:00:03Z' },
      ],
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.doesNotMatch(markup, /app-message-read-receipts/);
  assert.doesNotMatch(markup, /Read by 2/);
  assert.doesNotMatch(markup, /Alice/);
  assert.doesNotMatch(markup, /Bob/);
  assert.match(markup, /data-message-context-menu-target="true"/);
  assert.match(markup, /data-message-delivery-glyph="double-check"/);
});

test('message context menu content lists read receipts when available', () => {
  const message: Message = {
    id: 'msg:read-receipts-menu',
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello group',
    time: '00:45',
    readReceiptSummary: {
      count: 2,
      participants: [
        { id: 'human:acct_a', name: 'Alice', avatarSeed: 'cloud:acct_a', profileImageUrl: null, readAt: '2026-06-06T12:00:02Z' },
        { id: 'human:acct_b', name: 'Bob', avatarSeed: 'cloud:acct_b', profileImageUrl: null, readAt: '2026-06-06T12:00:03Z' },
      ],
    },
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, { msg: message }));

  assert.match(markup, /data-message-context-menu-content="true"/);
  assert.match(markup, /w-\[13\.5rem\]/);
  assert.doesNotMatch(markup, /data-message-context-menu-reactions="true"/);
  assert.match(markup, /Reply/);
  assert.match(markup, /Copy Text/);
  assert.match(markup, /Select/);
  assert.doesNotMatch(markup, />Edit</);
  assert.doesNotMatch(markup, />Delete</);
  assert.match(markup, /data-message-context-menu-seen-row="true"/);
  assert.match(markup, /2 Seen/);
  assert.match(markup, /title="Seen by Alice, Bob"/);
  assert.doesNotMatch(markup, /Readers/);
  assert.doesNotMatch(markup, /data-message-read-receipts-context-content/);
  assert.match(markup, /text-\[10px\]/);
  assert.match(markup, /font-normal/);
  assert.match(markup, /leading-\[1\.45\]/);
  assert.match(markup, /style="font-size:10px;font-weight:400;line-height:1\.45"/);
  assert.doesNotMatch(markup, /h-6 w-6/);
  assert.match(markup, /py-1\.5/);
  assert.doesNotMatch(markup, /text-\[9\.5px\]/);
  assert.doesNotMatch(markup, /text-\[11px\]/);
  assert.doesNotMatch(markup, /text-\[12\.5px\]/);
  assert.doesNotMatch(markup, /app-message-context-menu-action[^\"]*text-\[13px\]/);
  assert.doesNotMatch(markup, /data-message-context-menu-seen-row="true"[^>]*text-\[13px\]/);
  assert.doesNotMatch(markup, /text-\[16px\]/);
  assert.doesNotMatch(markup, /font-semibold/);
  assert.doesNotMatch(markup, /font-medium/);
  assert.doesNotMatch(markup, /py-3/);
  assert.doesNotMatch(markup, /py-2/);
});

test('message context menu exposes only wired actions for eligible messages', () => {
  const message: Message = {
    id: 'msg:quote-target',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Quote me',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onClose: () => undefined,
    onReplyMessage: () => undefined,
    onForwardMessage: () => undefined,
    onSelectMessage: () => undefined,
    onRequestPinMessage: () => undefined,
  }));

  assert.match(markup, />Reply</);
  assert.match(markup, />Forward</);
  assert.match(markup, />Select</);
  assert.match(markup, />Pin</);
  assert.match(markup, /data-message-context-menu-action="reply"/);
  assert.match(markup, /data-message-context-menu-action="forward"/);
  assert.match(markup, /data-message-context-menu-action="select"/);
  assert.match(markup, /data-message-context-menu-action="pin"/);
  assert.doesNotMatch(markup, /data-message-context-menu-reactions="true"/);
  assert.doesNotMatch(markup, />Edit</);
  assert.doesNotMatch(markup, />Delete</);
  assert.doesNotMatch(markup, />View 1 Reply/);
});

test('message context menu exposes Unpin for pinned messages', () => {
  const message: Message = {
    id: 'msg:pinned',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Pinned text',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    isPinned: true,
    onRequestPinMessage: () => undefined,
    onRequestUnpinMessage: () => undefined,
  }));

  assert.match(markup, />Unpin</);
  assert.match(markup, /data-message-context-menu-action="unpin"/);
  assert.doesNotMatch(markup, />Pin</);
});

test('message context menu hides text copy when no text exists', () => {
  const message: Message = {
    id: 'msg:empty',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: '',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, { msg: message }));

  assert.doesNotMatch(markup, />Copy Text</);
  assert.doesNotMatch(markup, /data-message-context-menu-action="copy-text"/);
});

test('message context menu hides reply forward select and pin for live turns until completed', () => {
  const message: Message = {
    id: 'turn-live-message',
    role: 'owned-agent',
    sender: 'My Kordi',
    senderType: 'agent',
    text: '',
    time: '10:42',
    turn: {
      id: 'turn-live',
      sessionId: 'session-1',
      prompt: 'hello',
      status: 'writing',
      message: 'Replying…',
      assistantText: 'partial',
      thinkingText: '',
      tools: [],
      completed: false,
      succeeded: false,
    },
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onReplyMessage: () => undefined,
    onForwardMessage: () => undefined,
    onSelectMessage: () => undefined,
    onRequestPinMessage: () => undefined,
  }));

  assert.doesNotMatch(markup, />Reply</);
  assert.doesNotMatch(markup, />Forward</);
  assert.doesNotMatch(markup, />Select</);
  assert.doesNotMatch(markup, />Pin</);
  assert.match(markup, />Copy Text</);
});

test('pinned message bar renders sender preview and unpin affordance', () => {
  const message: Message = {
    id: 'msg:pinned-bar',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Pinned message body',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(PinnedMessageBar, {
    message,
    onOpenMessage: () => undefined,
    onRequestUnpin: () => undefined,
  }));

  assert.match(markup, /data-pinned-message-bar="true"/);
  assert.match(markup, /Pinned message/);
  assert.match(markup, /Alice: Pinned message body/);
  assert.match(markup, /aria-label="Unpin pinned message"/);
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
    onRequestBridgeContact: async () => undefined,
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
    onRequestBridgeContact: async () => undefined,
  }));

  assert.match(markup, />Message not delivered\.</);
  assert.match(markup, />Send contact request</);
  assert.doesNotMatch(markup, />Contact request is pending\. They need to approve it before messages can be delivered\.</);
});

test('renders transcript system notices with compact stable spacing', () => {
  const message: Message = {
    role: 'system',
    text: 'Switched model to openai/gpt-5.5',
    time: '22:09',
    detail: 'Model updated',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-system-notice-row/);
  assert.match(markup, /app-system-notice-pill/);
  assert.match(markup, /py-0\.5/);
  assert.doesNotMatch(markup, /flex justify-center py-2/);
});

test('renders human messages with a larger reading width than before', () => {
  const message: Message = {
    role: 'person',
    sender: 'Shenzhe Zhu',
    senderType: 'human',
    isOwnMessage: false,
    text: '@ShenzheZhusKordi Based on the current Kordi repo issue template, I’d like to propose adding model awareness to the system prompt.',
    time: '21:54',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /max-w-\[34rem\]/);
  assert.match(markup, /text-\[14px\]/);
  assert.doesNotMatch(markup, /max-w-\[26rem\]/);
});

test('renders plain My Kordi replies on a subtle assistant surface', () => {
  const message: Message = {
    role: 'owned-agent',
    sender: 'My Kordi',
    senderType: 'agent',
    text: 'Hey! I am doing well, thanks for asking.',
    time: '14:30',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-chat-bubble-agent/);
  assert.match(markup, />Hey! I am doing well, thanks for asking\.</);
  assert.doesNotMatch(markup, /app-message-bubble-own|app-message-bubble-peer/);
});

test('renders peer human sender names inside the bubble with colorful bold styling', () => {
  const message: Message = {
    role: 'person',
    sender: 'xin hai Mouse',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: '我都不知道',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-chat-bubble-peer[\s\S]*app-message-inline-sender/);
  assert.match(markup, /app-message-inline-sender[^>]*font-semibold/);
  assert.match(markup, /--app-message-sender-accent/);
  assert.match(markup, />xin hai Mouse</);
  assert.doesNotMatch(markup, /app-message-meta px-1[\s\S]*xin hai Mouse/);
});

test('compact contact density hides peer sender names and uses squarer tighter human bubbles', () => {
  const message: Message = {
    role: 'person',
    sender: 'xin hai Mouse',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: '我都不知道',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'contact-compact',
  }));

  assert.match(markup, /data-transcript-density="contact-compact"/);
  assert.match(markup, /app-message-row-contact-compact/);
  assert.match(markup, /app-message-bubble-contact-compact/);
  assert.match(markup, /px-3 py-1\.5/);
  assert.match(markup, /rounded-\[8px\]/);
  assert.match(markup, /h-5\.5 w-5\.5/);
  assert.doesNotMatch(markup, /app-message-inline-sender/);
  assert.doesNotMatch(markup, />xin hai Mouse<\/div>/);
});

test('compact agent density makes user request bubbles square and tight', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    showSenderMeta: false,
    text: 'hi',
    time: '01:07',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'agent-compact',
  }));

  assert.match(markup, /data-transcript-density="agent-compact"/);
  assert.match(markup, /app-message-row-contact-compact/);
  assert.match(markup, /app-message-bubble-contact-compact/);
  assert.match(markup, /rounded-\[8px\]/);
  assert.match(markup, /px-3 py-1\.5/);
  assert.doesNotMatch(markup, /app-message-inline-sender/);
});

test('default human bubbles still render inline sender names', () => {
  const message: Message = {
    role: 'person',
    sender: 'xin hai Mouse',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: 'Group context still needs a visible sender label.',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-chat-bubble-peer[\s\S]*app-message-inline-sender/);
  assert.match(markup, />xin hai Mouse<\/div>/);
  assert.doesNotMatch(markup, /data-transcript-density="contact-compact"/);
});

test('compact group density hides sender labels inside message bubbles', () => {
  const first: Message = {
    id: 'msg:first-group-compact',
    role: 'person',
    sender: 'xin hai Mouse',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: 'Group context still needs a visible sender label.',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };
  const second: Message = {
    ...first,
    id: 'msg:second-group-compact',
    text: 'But repeated rows should stay compact.',
  };

  const markup = renderToStaticMarkup(createElement('div', null,
    createElement(MessageBubble, { msg: first, densityMode: 'group-compact', isGroupedWithNext: true }),
    createElement(MessageBubble, { msg: second, densityMode: 'group-compact', isGroupedWithPrevious: true }),
  ));

  assert.match(markup, /data-transcript-density="group-compact"/);
  assert.match(markup, /app-message-row-contact-compact/);
  assert.match(markup, /app-message-bubble-contact-compact/);
  assert.match(markup, /px-3 py-1\.5/);
  assert.match(markup, /rounded-\[8px\]/);
  assert.doesNotMatch(markup, /app-message-inline-sender/);
  assert.doesNotMatch(markup, />xin hai Mouse<\/div>/);
  assert.equal((markup.match(/data-avatar-kind="human"/g) ?? []).length, 1);
});

test('groups consecutive same-sender human messages with one inline name and one avatar', () => {
  const first: Message = {
    id: 'msg:first',
    role: 'person',
    sender: '成龙',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: '一会草坪婚礼还有重头戏',
    time: '09:57',
    senderAvatarSeed: 'person:chenglong',
  };
  const second: Message = {
    ...first,
    id: 'msg:second',
    text: '俩人要念清真言',
  };

  const markup = renderToStaticMarkup(createElement('div', null,
    createElement(MessageBubble, { msg: first, isGroupedWithNext: true }),
    createElement(MessageBubble, { msg: second, isGroupedWithPrevious: true }),
  ));

  assert.equal((markup.match(/app-message-inline-sender/g) ?? []).length, 1);
  assert.equal((markup.match(/data-avatar-kind="human"/g) ?? []).length, 1);
});

test('assistant response surfaces are square and tighter with less blank space', () => {
  const css = readDesktopShellCss();
  const surfaceBlock = css.match(/\.app-live-assistant-answer-surface\s*\{[^}]+\}/)?.[0] ?? '';

  assert.match(surfaceBlock, /border-radius:\s*8px;/);
  assert.match(surfaceBlock, /padding:\s*0\.55rem 0\.7rem 0\.5rem;/);
  assert.doesNotMatch(surfaceBlock, /border-radius:\s*16px;/);
  assert.doesNotMatch(surfaceBlock, /padding:\s*0\.78rem 0\.9rem 0\.68rem;/);
});

test('renders completed assistant responses as a compact contrast surface', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-contrast-answer',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Done — filed as issue #217 using the repo’s current Feature request template.',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.match(markup, /app-live-turn-response-panel app-live-assistant-answer-surface/);
  assert.match(markup, /max-w-\[min\(100%,42rem\)\]/);
  assert.match(markup, /app-live-assistant-answer-markdown/);
  assert.doesNotMatch(markup, /max-w-\[min\(100%,46rem\)\]/);
});

test('renders request reply status as a compact icon and count without reply text', () => {
  const message: Message = {
    id: 'msg:request',
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@SomeAgent please check launch risks.',
    time: '10:00',
    replySummary: {
      replyCount: 1,
      pending: true,
      targetMessageId: 'msg:response',
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-message-reply-line/);
  assert.match(markup, /app-message-reply-line-icon/);
  assert.match(markup, /app-message-reply-count[^>]*>1</);
  assert.doesNotMatch(markup, />[^<]*(?:reply|replies|replying…)[^<]*</i);
  assert.doesNotMatch(markup, /↳/);
  assert.doesNotMatch(markup, /Alice|Bob|Kordi/);
  assert.doesNotMatch(markup, /app-message-reply-pill/);
});

test('renders agent source quote and processing status without an output block before text exists', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-processing-with-source',
    sessionId: 'session-1',
    prompt: '',
    status: 'processing',
    message: 'Processing…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
    sourceMessage: {
      messageId: 'msg:request',
      senderLabel: 'You',
      text: '@AliceKordi review the copy and call out confusing parts.',
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn }));

  assert.match(markup, /app-live-turn-response-panel app-live-assistant-answer-surface/);
  assert.match(markup, /app-source-message-quote/);
  assert.match(markup, /app-source-message-quote-rail/);
  assert.doesNotMatch(markup, /app-source-message-quote-icon/);
  assert.match(markup, />You: <\/span>@AliceKordi review the copy/);
  assert.doesNotMatch(markup, /app-source-message-quote-label block truncate/);
  assert.doesNotMatch(markup, /Replying to/);
  assert.match(markup, /@AliceKordi review the copy/);
  assert.match(markup, /Processing/);
  assert.doesNotMatch(markup, /app-live-assistant-answer-markdown/);
  assert.doesNotMatch(markup, /checking auth screenshots/);
});

test('folds long source quotes after three lines while keeping the full request text in the DOM', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-long-source-quote',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'I filed the issue.',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
    sourceMessage: {
      messageId: 'msg:long-request',
      senderLabel: 'Jiaxin',
      text: [
        '@JiaxinsKordi create a github issue about this bug.',
        'Use the current Kordi repo issue template and keep the reproduction details.',
        'Mention that the bug affects Chinese Pinyin IME confirmation.',
        'Final acceptance detail should remain available when folded.',
      ].join('\n'),
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.match(markup, /app-source-message-quote-text-frame app-source-message-quote-folded/);
  assert.match(markup, /app-source-message-quote-toggle app-source-message-quote-toggle-overlay/);
  assert.match(markup, /text-\[9px\]/);
  assert.match(markup, /— Click to show full request —/);
  assert.doesNotMatch(markup, /— Show full request —/);
  assert.match(markup, /Final acceptance detail should remain available when folded/);
  assert.doesNotMatch(markup, /Final acceptance detail should remain available when folded…/);
});

test('styles folded source quote expand control as muted overlay on the fade', () => {
  const shellCss = readDesktopShellCss();
  const sourceToggleBlock = shellCss.match(/\.app-source-message-quote-toggle \{[\s\S]*?\n\}/)?.[0] ?? '';
  const sourceOverlayBlock = shellCss.match(/\.app-source-message-quote-toggle-overlay \{[\s\S]*?\n\}/)?.[0] ?? '';
  const sourceFoldedAfterBlock = shellCss.match(/\.app-source-message-quote-folded::after \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(sourceToggleBlock, /color:\s*color-mix\(in oklab, var\(--app-source-message-quote-foreground\) 84%, var\(--app-source-message-quote-muted\)\)/);
  assert.doesNotMatch(sourceToggleBlock, /rgb\(147 197 253\)/);
  assert.match(sourceOverlayBlock, /position:\s*absolute/);
  assert.match(sourceOverlayBlock, /bottom:\s*0\.1rem/);
  assert.match(sourceOverlayBlock, /background:\s*transparent/);
  assert.match(sourceOverlayBlock, /border:\s*0/);
  assert.match(sourceOverlayBlock, /backdrop-filter:\s*none/);
  assert.match(sourceFoldedAfterBlock, /mask-image:\s*linear-gradient/);
  assert.match(sourceFoldedAfterBlock, /backdrop-filter:\s*blur\(/);
});

test('styles reply attribution surfaces with stronger dark-mode contrast', () => {
  const shellCss = readDesktopShellCss();
  const responsePanelBlock = shellCss.match(/\.app-live-turn-response-panel \{[\s\S]*?\n\}/)?.[0] ?? '';
  const responseSurfaceBlock = shellCss.match(/\.app-live-assistant-answer-surface \{[\s\S]*?\n\}/)?.[0] ?? '';
  const quoteLinkBlock = shellCss.match(/\.app-source-message-quote-link \{[\s\S]*?\n\}/)?.[0] ?? '';
  const quoteLabelBlock = shellCss.match(/\.app-source-message-quote-label \{[\s\S]*?\n\}/)?.[0] ?? '';
  const quoteTextBlock = shellCss.match(/\.app-source-message-quote-text \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(responsePanelBlock, /var\(--app-control-bg\) 74%/);
  // Agent reply surface is intentionally flat: no border, no shadow, subtle fill.
  assert.match(responseSurfaceBlock, /border:\s*0/);
  assert.match(responseSurfaceBlock, /box-shadow:\s*none/);
  assert.match(responseSurfaceBlock, /background:\s*color-mix\(in oklab, var\(--utility-foreground\) 3%, transparent\)/);
  assert.match(quoteLinkBlock, /var\(--app-source-message-quote-bg\)/);
  assert.match(quoteLabelBlock, /var\(--app-source-message-quote-label\)/);
  assert.match(quoteTextBlock, /var\(--app-source-message-quote-text\)/);
});

test('styles source quote colors contextually inside own message bubbles for dark and light modes', () => {
  const shellCss = readDesktopShellCss();
  const quoteRootBlock = shellCss.match(/\.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';
  const ownBubbleQuoteBlock = shellCss.match(/\.app-chat-bubble-user \.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightOwnBubbleQuoteBlock = shellCss.match(/\.bridge-app\.theme-light \.app-chat-bubble-user \.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';
  const peerBubbleQuoteBlock = shellCss.match(/\.app-chat-bubble-peer \.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(quoteRootBlock, /--app-source-message-quote-foreground:\s*var\(--utility-foreground\)/);
  assert.match(quoteRootBlock, /--app-source-message-quote-text:\s*color-mix\(in oklab, var\(--app-source-message-quote-foreground\) 82%, var\(--app-source-message-quote-muted\)\)/);
  assert.match(ownBubbleQuoteBlock, /--app-source-message-quote-foreground:\s*var\(--app-chat-bubble-user-text\)/);
  assert.match(ownBubbleQuoteBlock, /--app-source-message-quote-muted:\s*color-mix\(in oklab, var\(--app-chat-bubble-user-text\) 72%, transparent\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-foreground:\s*rgb\(255 255 255\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-label:\s*rgba\(255, 255, 255, 0\.88\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-text:\s*rgba\(255, 255, 255, 0\.76\)/);
  assert.match(peerBubbleQuoteBlock, /--app-source-message-quote-bg:\s*color-mix\(in oklab, var\(--app-source-message-quote-foreground\) 8%, transparent\)/);
});

test('keeps medium completed agent responses readable without folding too early', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-long-answer',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Line one\nLine two\nLine three\nLine four',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.doesNotMatch(markup, /app-live-assistant-answer-folded/);
  assert.doesNotMatch(markup, /Show full response/);
});

test('folds only substantially long completed agent responses by default', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-long-answer',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.match(markup, /app-live-assistant-answer-content app-live-assistant-answer-folded/);
  assert.match(markup, /app-inline-expand-toggle/);
  assert.match(markup, /app-live-assistant-answer-toggle app-live-assistant-answer-toggle-overlay/);
  assert.match(markup, /text-\[10px\]/);
  assert.match(markup, /— 1 more line\. Click to show all —/);
  assert.doesNotMatch(markup, /— Show full response —/);
});

test('expanded fold controls use click-to-hide copy consistently', () => {
  const transcriptSource = [
    readFileSync(new URL('../src/kordi-app/components/transcriptReplyAttribution.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/kordi-app/components/transcriptLiveTurns.tsx', import.meta.url), 'utf8'),
  ].join('\n');

  assert.match(transcriptSource, /— Click to hide request —/);
  assert.match(transcriptSource, /— Click to hide response —/);
  assert.doesNotMatch(transcriptSource, /— Hide request —/);
  assert.doesNotMatch(transcriptSource, /— Collapse response —/);
});

test('styles folded answer expand control as muted overlay on the fade', () => {
  const shellCss = readDesktopShellCss();
  const answerToggleBlock = shellCss.match(/\.app-live-assistant-answer-toggle \{[\s\S]*?\n\}/)?.[0] ?? '';
  const overlayToggleBlock = shellCss.match(/\.app-live-assistant-answer-toggle-overlay \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(answerToggleBlock, /color:\s*color-mix\(in oklab, var\(--utility-foreground\) 78%, var\(--utility-muted-text\)\)/);
  assert.doesNotMatch(answerToggleBlock, /rgb\(147 197 253\)/);
  assert.match(overlayToggleBlock, /position:\s*absolute/);
  assert.match(overlayToggleBlock, /bottom:\s*0\.18rem/);
  assert.match(overlayToggleBlock, /z-index:\s*1/);
  assert.doesNotMatch(overlayToggleBlock, /z-index:\s*2/);
});

const quoteToolAnswerSurfacePattern = /app-live-turn-response-panel app-live-assistant-answer-surface[\s\S]*app-source-message-quote[\s\S]*app-transcript-tool-timeline[\s\S]*app-live-assistant-answer/;

test('keeps source quote and tool summary inside the same assistant response background', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-source-tools-answer',
    sessionId: 'session-1',
    prompt: '',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Done — filed as issue #216.',
    thinkingText: '',
    tools: [{
      id: 'tool-issue',
      name: 'bash',
      status: 'done',
      arguments: '{"command":"gh issue create"}',
      liveOutput: '',
      resultText: 'https://github.com/Kordi-AI/Kordi/issues/216',
      detail: null,
      isError: false,
    }],
    completed: true,
    succeeded: true,
    error: null,
    sourceMessage: {
      messageId: 'msg:request',
      senderLabel: 'Jiaxin',
      text: '@JiaxinsKordi create a github issue about this bug.',
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));

  assert.match(markup, quoteToolAnswerSurfacePattern);
});

test('keeps short active streaming agent responses expanded while text is still arriving', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-streaming-answer',
    sessionId: 'session-1',
    prompt: '',
    status: 'streaming',
    message: 'Replying…',
    assistantText: 'Line one\nLine two\nLine three\nLine four',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn }));

  assert.doesNotMatch(markup, /app-live-assistant-answer-folded/);
  assert.doesNotMatch(markup, /Show full response/);
});

test('folds very long active streaming agent responses with remaining line count copy', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-streaming-long-answer',
    sessionId: 'session-1',
    prompt: '',
    status: 'streaming',
    message: 'Replying…',
    assistantText: 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn }));

  assert.match(markup, /app-live-assistant-answer-content app-live-assistant-answer-folded/);
  assert.match(markup, /— 2 more lines\. Click to show all —/);
});
