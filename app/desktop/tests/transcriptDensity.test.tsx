import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactRequestRow, LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
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
  assert.doesNotMatch(markup, /title="Sent"/);
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

test('renders peer human sender names inside the bubble with restrained accent styling', () => {
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
  assert.match(markup, /app-message-inline-sender[^>]*font-medium/);
  assert.doesNotMatch(markup, /app-message-inline-sender[^>]*font-semibold/);
  assert.match(markup, /--app-message-sender-accent:oklch\(0\.68 0\.075 /);
  assert.match(markup, />xin hai Mouse</);
  assert.doesNotMatch(markup, /app-message-meta px-1[\s\S]*xin hai Mouse/);
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

test('renders request reply status as an external plain one-line count without names', () => {
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
  assert.match(markup, />1 reply · replying…</);
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
  assert.match(markup, /app-source-message-quote-icon/);
  assert.match(markup, />You</);
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

  assert.match(sourceToggleBlock, /color:\s*color-mix\(in oklab, var\(--utility-foreground\) 78%, var\(--utility-muted-text\)\)/);
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
  assert.match(quoteLinkBlock, /var\(--utility-foreground\) 7%/);
  assert.match(quoteLabelBlock, /var\(--utility-foreground\) 92%/);
  assert.match(quoteTextBlock, /var\(--utility-foreground\) 68%/);
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
  assert.match(overlayToggleBlock, /z-index:\s*2/);
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
