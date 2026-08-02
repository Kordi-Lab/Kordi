import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

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
  assert.doesNotMatch(markup, /app-source-message-quote-rail/);
  assert.doesNotMatch(markup, /app-source-message-quote-icon/);
  assert.match(markup, />You: <\/span>@AliceKordi review the copy/);
  assert.doesNotMatch(markup, /app-source-message-quote-label block truncate/);
  assert.doesNotMatch(markup, /Replying to/);
  assert.match(markup, /@AliceKordi review the copy/);
  assert.match(markup, /Processing/);
  assert.doesNotMatch(markup, /app-live-assistant-answer-markdown/);
  assert.doesNotMatch(markup, /checking auth screenshots/);
});

test('human reply preview is an inset replying-to rectangle without the quote rail', () => {
  const baseMessage: Message = {
    id: 'msg-reply-own',
    role: 'user',
    senderType: 'human',
    isOwnMessage: true,
    text: 'Updated. The patch is small and covered by tests.',
    time: '10:44',
    sourceMessage: {
      messageId: 'msg-source',
      senderLabel: 'Jiaxin',
      text: 'keep it concise',
      attachmentCount: 0,
    },
  };
  const ownMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: baseMessage }));
  const peerMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: {
      ...baseMessage,
      id: 'msg-reply-peer',
      role: 'person',
      senderType: 'human',
      isOwnMessage: false,
      sender: 'Jiaxin',
    },
  }));
  const shellCss = readDesktopShellCss();
  const quoteLinkBlock = shellCss.match(/\.app-source-message-quote-link \{[\s\S]*?\n\}/)?.[0] ?? '';
  const railRule = shellCss.match(/\.app-source-message-quote-rail \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(ownMarkup, /app-chat-bubble-user/);
  assert.match(peerMarkup, /app-chat-bubble-peer/);
  assert.match(ownMarkup, />Replying to: <\/span>keep it concise/);
  assert.match(peerMarkup, />Replying to: <\/span>keep it concise/);
  assert.doesNotMatch(ownMarkup, />Jiaxin: <\/span>keep it concise/);
  assert.doesNotMatch(peerMarkup, />Jiaxin: <\/span>keep it concise/);
  assert.match(quoteLinkBlock, /grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(quoteLinkBlock, /border-radius:\s*7px;/);
  assert.match(quoteLinkBlock, /padding:\s*0\.34rem 0\.62rem;/);
  assert.match(railRule, /display:\s*none;/);
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
  assert.match(markup, /app-fold-reveal-row app-source-message-quote-reveal-row/);
  assert.match(markup, /app-source-message-quote-toggle/);
  assert.match(markup, /Show full request/);
  assert.doesNotMatch(markup, /app-source-message-quote-toggle-overlay/);
  assert.doesNotMatch(markup, /— Click to show full request —/);
  assert.match(markup, /Final acceptance detail should remain available when folded/);
  assert.doesNotMatch(markup, /Final acceptance detail should remain available when folded…/);
});

test('styles folded source quote reveal as a compact inline control', () => {
  const shellCss = readDesktopShellCss();
  const sourceToggleBlock = shellCss.match(/\.app-source-message-quote-toggle \{[\s\S]*?\n\}/)?.[0] ?? '';
  const sharedToggleBlock = shellCss.match(/\.app-inline-expand-toggle \{[\s\S]*?\n\}/)?.[0] ?? '';
  const revealRowBlock = shellCss.match(/\.app-fold-reveal-row \{[\s\S]*?\n\}/)?.[0] ?? '';
  const sourceFoldedAfterBlock = shellCss.match(/\.app-source-message-quote-folded::after \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(sourceToggleBlock, /color:\s*color-mix\(in oklab, var\(--app-source-message-quote-foreground\) 88%, var\(--app-source-message-quote-muted\)\)/);
  assert.match(sharedToggleBlock, /min-height:\s*30px/);
  assert.match(sharedToggleBlock, /border-radius:\s*9px/);
  assert.match(revealRowBlock, /display:\s*flex/);
  assert.doesNotMatch(shellCss, /\.app-source-message-quote-toggle-overlay/);
  assert.match(sourceFoldedAfterBlock, /height:\s*1\.05rem/);
  assert.doesNotMatch(sourceFoldedAfterBlock, /backdrop-filter:\s*blur\(/);
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
  const lightOwnBubbleQuoteBlock = shellCss.match(/\.kordi-app\.theme-light \.app-chat-bubble-user \.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';
  const peerBubbleQuoteBlock = shellCss.match(/\.app-chat-bubble-peer \.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(quoteRootBlock, /--app-source-message-quote-foreground:\s*var\(--utility-foreground\)/);
  assert.match(quoteRootBlock, /--app-source-message-quote-text:\s*color-mix\(in oklab, var\(--app-source-message-quote-foreground\) 82%, var\(--app-source-message-quote-muted\)\)/);
  assert.match(ownBubbleQuoteBlock, /--app-source-message-quote-foreground:\s*var\(--app-chat-bubble-user-text\)/);
  assert.match(ownBubbleQuoteBlock, /--app-source-message-quote-muted:\s*color-mix\(in oklab, var\(--app-chat-bubble-user-text\) 72%, transparent\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-foreground:\s*rgb\(31 49 69\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-label:\s*rgba\(31, 49, 69, 0\.86\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-text:\s*rgba\(31, 49, 69, 0\.74\)/);
  assert.match(lightOwnBubbleQuoteBlock, /--app-source-message-quote-fade-bg:\s*rgb\(226 235 245\)/);
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
  assert.match(markup, /app-fold-reveal-row app-live-assistant-answer-reveal-row/);
  assert.match(markup, /app-inline-expand-toggle/);
  assert.match(markup, /app-live-assistant-answer-toggle/);
  assert.match(markup, /Show 1 more line/);
  assert.doesNotMatch(markup, /app-live-assistant-answer-toggle-overlay/);
  assert.doesNotMatch(markup, /— 1 more line\. Click to show all —/);
});

test('expanded fold controls use click-to-hide copy consistently', () => {
  const transcriptSource = [
    readFileSync(new URL('../src/kordi-app/components/transcriptReplyAttribution.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/kordi-app/components/transcriptAssistantAnswer.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/kordi-app/components/transcriptLiveTurns.tsx', import.meta.url), 'utf8'),
  ].join('\n');

  assert.match(transcriptSource, /Hide request/);
  assert.match(transcriptSource, /Hide response/);
  assert.doesNotMatch(transcriptSource, /— Click to hide request —/);
  assert.doesNotMatch(transcriptSource, /— Click to hide response —/);
});

test('styles folded answer reveal as a compact inline control', () => {
  const shellCss = readDesktopShellCss();
  const answerToggleBlock = shellCss.match(/\.app-live-assistant-answer-toggle \{[\s\S]*?\n\}/)?.[0] ?? '';
  const sharedToggleBlock = shellCss.match(/\.app-inline-expand-toggle \{[\s\S]*?\n\}/)?.[0] ?? '';
  const answerFoldedAfterBlock = shellCss.match(/\.app-live-assistant-answer-folded::after \{[\s\S]*?\n\}/)?.[0] ?? '';
  const revealLineBlock = shellCss.match(/\.app-fold-reveal-line \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(answerToggleBlock, /color:\s*color-mix\(in oklab, var\(--utility-foreground\) 86%, var\(--utility-muted-text\)\)/);
  assert.match(sharedToggleBlock, /min-height:\s*30px/);
  assert.match(sharedToggleBlock, /border-radius:\s*9px/);
  assert.match(revealLineBlock, /linear-gradient\(90deg/);
  assert.doesNotMatch(shellCss, /\.app-live-assistant-answer-toggle-overlay/);
  assert.match(answerFoldedAfterBlock, /height:\s*1\.05rem/);
  assert.doesNotMatch(answerFoldedAfterBlock, /backdrop-filter:\s*blur\(/);
});

test('light theme keeps folded assistant markdown readable against the answer surface', () => {
  const themeOverridesCss = readDesktopShellCss();
  const lightAnswerMarkdownBlock = themeOverridesCss.match(/\.kordi-app\.theme-light \.app-live-assistant-answer-markdown :where\(p, li, blockquote, td, th, strong, em\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightAnswerListBlock = themeOverridesCss.match(/\.kordi-app\.theme-light \.app-live-assistant-answer-markdown :where\(ol, ul\) \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(lightAnswerMarkdownBlock, /color:\s*var\(--utility-foreground\)\s*!important;/);
  assert.match(lightAnswerListBlock, /color:\s*var\(--utility-foreground\)\s*!important;/);
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
  assert.match(markup, /Show 2 more lines/);
  assert.doesNotMatch(markup, /— 2 more lines\. Click to show all —/);
});
