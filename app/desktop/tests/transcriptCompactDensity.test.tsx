import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportReportSubmissionProvider } from '../src/features/support/SupportReportSubmissionContext';
import { LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('renders transcript system notices as neutral text without a colored pill', () => {
  const message: Message = {
    role: 'system',
    text: 'Switched model to openai/gpt-5.5',
    time: '22:09',
    detail: 'Model updated',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-system-notice-row/);
  assert.match(markup, /app-system-notice-text/);
  assert.match(markup, /text-\[color:var\(--utility-muted-text\)\]/);
  assert.match(markup, /py-0\.5/);
  assert.doesNotMatch(markup, /bg-muted|rounded-full|\bborder\b|text-muted-foreground/);
  assert.doesNotMatch(markup, /flex justify-center py-2/);
});

test('renders group meetings as neutral video-chat service events', () => {
  const message: Message = {
    role: 'person',
    sender: 'Taylor',
    senderType: 'human',
    text: 'The video chat ended. Duration 00:10.',
    time: '14:35',
    callActivity: {
      callId: 'call-one',
      kind: 'meeting',
      event: 'ended',
      direction: 'incoming',
      outcome: 'completed',
      durationSeconds: 10,
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-system-notice-row/);
  assert.match(markup, /app-call-activity-inline/);
  assert.match(markup, /The video chat ended\. Duration 00:10\./);
  assert.doesNotMatch(markup, /app-chat-bubble-peer|app-chat-bubble-user|app-message-delivery-footer/);
});

test('renders direct call history with the same neutral service-event alignment', () => {
  const message: Message = {
    role: 'person',
    sender: 'Taylor',
    senderType: 'human',
    text: 'The voice call ended.',
    time: '14:35',
    callActivity: {
      callId: 'call-two',
      kind: 'voice',
      event: 'ended',
      direction: 'incoming',
      outcome: 'completed',
      durationSeconds: 7,
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-system-notice-row/);
  assert.match(markup, /The voice call ended\. Duration 00:07\./);
  assert.doesNotMatch(markup, /app-chat-bubble-peer|app-chat-bubble-user|app-message-delivery-footer/);
});

test('contact transcripts use the same neutral system-notice treatment', () => {
  const message: Message = {
    role: 'system',
    text: 'Switched model to openai/gpt-5.6-sol',
    time: '22:10',
    detail: 'Model updated',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'contact-compact',
  }));

  assert.match(markup, /app-system-notice-text/);
  assert.match(markup, /text-\[color:var\(--utility-muted-text\)\]/);
  assert.doesNotMatch(markup, /bg-muted|rounded-full|\bborder\b|text-muted-foreground/);
});

test('renders no fallback notice when transcript placeholders own loading', () => {
  const message: Message = {
    role: 'system',
    text: '',
    time: '--:--',
    detail: 'transcript-loading',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.doesNotMatch(
    markup,
    /role="status"|aria-live|animate-spin|app-transcript-loading-notice|Loading messages|Loading chat history/,
  );
});

test('renders human messages with a larger reading width than before', () => {
  const message: Message = {
    role: 'person',
    sender: 'Ethan Park',
    senderType: 'human',
    isOwnMessage: false,
    text: '@EthanParksKordi Based on the current Kordi repo issue template, I’d like to propose adding model awareness to the system prompt.',
    time: '21:54',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /max-w-\[52rem\]/);
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
    text: 'I honestly do not know',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    onOpenSenderProfile: () => undefined,
  }));

  assert.match(markup, /app-chat-bubble-peer[\s\S]*app-message-inline-sender/);
  assert.match(markup, /<div class="app-message-inline-sender/);
  assert.doesNotMatch(markup, /<button[^>]*app-message-inline-sender/);
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
    text: 'I honestly do not know',
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
  assert.match(markup, /h-7 w-7/);
  assert.doesNotMatch(markup, /app-message-inline-sender/);
  assert.doesNotMatch(markup, />xin hai Mouse<\/div>/);
});

test('Kordi Support answers use a normal contact bubble without agent reply UI', () => {
  const message: Message = {
    role: 'person',
    sender: 'Kordi Support',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: false,
    supportContactResponse: true,
    text: 'Hello! How can I help?',
    time: '19:11',
    senderProfileImageUrl: '/kordi-support-avatar.svg',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'contact-compact',
  }));

  assert.match(markup, /app-chat-bubble-peer/);
  assert.match(markup, /Hello! How can I help\?/);
  assert.match(markup, /kordi-support-avatar\.svg/);
  assert.doesNotMatch(markup, /app-live-turn-response-panel/);
  assert.doesNotMatch(markup, /Processing…/);
  assert.doesNotMatch(markup, /Me:/);
});

test('pending Kordi Support replies use a contact typing indicator without agent controls', () => {
  const message: Message = {
    role: 'person',
    sender: 'Kordi Support',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: false,
    supportContactResponse: true,
    supportContactTyping: true,
    text: '',
    time: '19:12',
    senderProfileImageUrl: '/kordi-support-avatar.svg',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'contact-compact',
  }));

  assert.match(markup, /app-chat-bubble-peer/);
  assert.match(markup, /data-support-contact-typing="true"/);
  assert.match(markup, /aria-label="Kordi Support is typing"/);
  assert.equal((markup.match(/app-support-contact-typing-dot app-support-contact-typing-dot-/g) ?? []).length, 3);
  assert.match(markup, /min-w-\[3\.25rem\]/);
  assert.doesNotMatch(markup, /app-live-turn-response-panel/);
  assert.doesNotMatch(markup, /Processing…|Me:|Stop/);
});

test('Kordi Support contact bubbles preserve reviewed report approval', () => {
  const message: Message = {
    role: 'person',
    sender: 'Kordi Support',
    senderType: 'human',
    isOwnMessage: false,
    supportContactResponse: true,
    text: `I drafted the issue for review.

<kordi-support-report>
{"category":"issue","subject":"Support reply UI","description":"Render Support as a normal contact message."}
</kordi-support-report>`,
    time: '19:12',
  };

  const markup = renderToStaticMarkup(createElement(
    SupportReportSubmissionProvider,
    {
      accountId: 'acct-test',
      sessionId: 'session-support',
      onSubmit: async () => ({ ticketId: 'ticket-test', status: 'open' }),
      onLookup: async () => null,
    },
    createElement(MessageBubble, { msg: message, densityMode: 'contact-compact' }),
  ));

  assert.match(markup, /I drafted the issue for review\./);
  assert.match(markup, /data-support-report-permission-card="true"/);
  assert.doesNotMatch(markup, /&lt;kordi-support-report&gt;/);
  assert.doesNotMatch(markup, /app-live-turn-response-panel/);
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

test('compact group transcript exposes a human sender profile action only on the avatar', () => {
  const message: Message = {
    id: 'msg:group-member-profile',
    role: 'person',
    sender: 'Maya Chen',
    senderIdentityId: 'human:acct_maya',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: 'Can you review this?',
    time: '10:00',
    senderAvatarSeed: 'person:maya',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'group-compact',
    onOpenSenderProfile: () => undefined,
  }));

  assert.equal((markup.match(/data-message-sender-profile="true"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /data-message-sender-profile-trigger/);
  assert.match(markup, /aria-label="Open Maya Chen profile"/);
  assert.match(markup, /data-avatar-kind="human"/);
});

test('groups consecutive same-sender human messages with one inline name and one avatar', () => {
  const first: Message = {
    id: 'msg:first',
    role: 'person',
    sender: 'Márta',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: 'The ceremony still has a main event',
    time: '09:57',
    senderAvatarSeed: 'person:chenglong',
  };
  const second: Message = {
    ...first,
    id: 'msg:second',
    text: 'They will read their vows next',
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
  assert.match(markup, /max-w-\[min\(100%,58rem\)\]/);
  assert.match(markup, /app-live-assistant-answer-markdown/);
  assert.doesNotMatch(markup, /max-w-\[min\(100%,42rem\)\]/);
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
