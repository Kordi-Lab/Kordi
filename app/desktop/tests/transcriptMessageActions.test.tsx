import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MessageBubble,
  MessageContextMenuContent,
} from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';
import { messageSnapshotKey } from '../src/kordi-app/components/transcriptMessageSnapshot';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

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

test('thread count changes invalidate the memoized message bubble', () => {
  const message: Message = {
    id: 'thread-root',
    role: 'person',
    sender: 'Peer',
    text: 'what',
    time: '07:35',
    threadSummary: { replyCount: 1 },
  };

  assert.notEqual(
    messageSnapshotKey(message),
    messageSnapshotKey({ ...message, threadSummary: { replyCount: 2 } }),
  );
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
  assert.match(markup, /inline-flex h-3\.5 w-4 shrink-0 justify-center/);
  assert.doesNotMatch(markup, /min-w-\[2\.1rem\]/);
  assert.doesNotMatch(markup, /min-w-\[(?:5\.5|6\.75)rem\]/);
  assert.doesNotMatch(markup, /right-0/);
  assert.doesNotMatch(markup, /pr-\[3\.75rem\]/);
  assert.doesNotMatch(markup, /pb-4/);
  assert.match(markup, /data-message-delivery-status="sent"/);
  assert.match(markup, /data-message-delivery-glyph="single-check"/);
  assert.match(markup, /aria-label="Sent"/);
  assert.match(markup, /opacity-100[^\"]*text-slate-400/);
  assert.match(markup, /opacity-0[^\"]*text-slate-400/);
  assert.doesNotMatch(markup, /app-message-bubble-enter/);
  assert.doesNotMatch(markup, /app-message-delivery-clock-active/);
  assert.doesNotMatch(markup, /title="Sent"/);
});

test('short peer messages shrink to their content while typing indicators keep a stable slot', () => {
  const message: Message = {
    role: 'person',
    sender: 'Maya',
    senderType: 'human',
    isOwnMessage: false,
    text: 'hi',
    time: '00:45',
  };

  const defaultMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  const compactMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'contact-compact',
  }));
  const defaultTypingMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...message, text: '', supportContactTyping: true },
  }));
  const compactTypingMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...message, text: '', supportContactTyping: true },
    densityMode: 'contact-compact',
  }));

  assert.doesNotMatch(defaultMarkup, /min-w-\[/);
  assert.doesNotMatch(compactMarkup, /min-w-\[/);
  assert.match(defaultTypingMarkup, /min-w-\[4rem\]/);
  assert.match(compactTypingMarkup, /min-w-\[3\.25rem\]/);
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
  assert.match(markup, /app-message-bubble-enter/);
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
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onReplyMessage: () => undefined,
  }));

  assert.match(markup, /data-message-context-menu-content="true"/);
  assert.match(markup, /w-\[13\.5rem\]/);
  assert.doesNotMatch(markup, /data-message-context-menu-reactions="true"/);
  assert.match(markup, /Reply/);
  assert.match(markup, />Copy</);
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

test('message context menu actions stay flat at rest and retain interaction feedback', () => {
  const message: Message = {
    id: 'msg:flat-context-actions',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Choose an action',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onReplyMessage: () => undefined,
    onForwardMessage: () => undefined,
    onSelectMessage: () => undefined,
    onRequestPinMessage: () => undefined,
  }));
  const css = readFileSync(new URL('../src/styles/transient-surfaces.css', import.meta.url), 'utf8');
  const actionClasses = [...markup.matchAll(/data-message-context-menu-action="[^"]+" class="([^"]+)"/g)]
    .map((match) => match[1]);

  assert.equal(actionClasses.length, 5);
  for (const className of actionClasses) {
    assert.match(className, /(?:^|\s)app-transient-flat-action(?:\s|$)/);
    assert.doesNotMatch(className, /(?:^|\s)app-transient-row(?:\s|$)/);
  }
  assert.match(markup, /app-transient-surface/);
  assert.match(css, /\.app-transient-surface \.app-transient-flat-action \{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.app-transient-surface \.app-transient-flat-action:hover,[\s\S]*?\.app-transient-surface \.app-transient-flat-action:focus-visible \{[\s\S]*?background:\s*var\(--app-transient-hover-bg\);/);
});

test('message context menu shows Blob Emoji reactions for synced messages', () => {
  const message: Message = {
    id: 'msg:blob-reaction',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'React to me',
    time: '10:42',
    reactionConversationId: 'conversation-id',
    reactionTargetMessageId: 'message-id',
    reactions: [{ value: 'blob:blobwave', accountIds: ['alice'] }],
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onReactMessage: () => undefined,
  }));

  assert.match(markup, /data-message-context-menu-reactions="true"/);
  assert.match(markup, /w-\[17\.5rem\]/);
  assert.match(markup, /Show all reactions/);
  assert.match(markup, /assets\/blob-emoji\/[a-f0-9]{64}\//);
  assert.doesNotMatch(markup, />Details</);
});

test('message reaction expansion chooses Noto when no emoji history exists', () => {
  const source = readFileSync(
    new URL('../src/kordi-app/components/messageReactions.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /initialCategory=\{recentItems\.length \? 'recent' : 'noto'\}/);
  assert.doesNotMatch(source, /initialCategory=\{quickReactions\.length/);
});

test('message reaction retry clears a previous error before sending', () => {
  const source = readFileSync(
    new URL('../src/app/useKordiMessageActions.ts', import.meta.url),
    'utf8',
  );
  const handler = source.slice(
    source.indexOf('const onReactMessage'),
    source.indexOf('const {', source.indexOf('const onReactMessage')),
  );

  assert.match(handler, /setDesktopChatError\(null\);\s*try \{\s*await setCloudMessageReaction/);
});

test('message reactions tuck under the bubble and clear the avatar', () => {
  const peer: Message = {
    id: 'peer-reaction',
    role: 'person',
    sender: 'Maya',
    senderType: 'human',
    text: 'React here',
    time: '19:09',
    reactions: [{ value: 'blob:blobwave', accountIds: ['maya'] }],
  };
  const own: Message = {
    ...peer,
    id: 'own-reaction',
    role: 'user',
    sender: 'Me',
    isOwnMessage: true,
  };
  const peerMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: peer }));
  const ownMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: own }));
  const css = readDesktopShellCss();

  assert.match(peerMarkup, /app-message-reaction-chips-peer/);
  assert.match(ownMarkup, /app-message-reaction-chips-own/);
  assert.match(css, /\.app-message-reaction-chips \{[\s\S]*?margin-top:\s*-0\.625rem;/);
  assert.match(css, /\.app-message-reaction-chips-peer \{[\s\S]*?margin-left:\s*2\.25rem;/);
  assert.match(css, /\.app-message-reaction-chips-own \{[\s\S]*?margin-right:\s*2\.25rem;/);
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

  assert.match(markup, />Reply in conversation</);
  assert.match(markup, />Forward</);
  assert.match(markup, />Select</);
  assert.match(markup, />Pin</);
  assert.match(markup, /data-message-context-menu-action="reply-conversation"/);
  assert.doesNotMatch(markup, /data-message-context-menu-action="reply-thread"/);
  assert.match(markup, /data-message-context-menu-action="forward"/);
  assert.match(markup, /data-message-context-menu-action="select"/);
  assert.match(markup, /data-message-context-menu-action="pin"/);
  assert.doesNotMatch(markup, /data-message-context-menu-reactions="true"/);
  assert.doesNotMatch(markup, />Edit</);
  assert.doesNotMatch(markup, />Delete</);
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

  assert.doesNotMatch(markup, />Copy</);
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
  assert.match(markup, />Copy</);
});
