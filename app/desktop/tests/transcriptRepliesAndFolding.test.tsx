import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { shouldSuppressAgentReplyAttribution } from '../src/features/chat/replyAttribution';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('renders agent source quote and waiting waveform without an output block before text exists', () => {
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

  assert.equal(shouldSuppressAgentReplyAttribution({ id: 'session:group:1', type: 'external-agent', canonicalParticipantCount: 4 }), false);
  assert.equal(shouldSuppressAgentReplyAttribution({ id: 'private-fork', type: 'external-agent', forkedFromSessionId: 'session:group:1' }), false);
  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn }));

  assert.match(markup, /app-live-turn-response-panel app-live-assistant-answer-surface[\s\S]*app-agent-waiting-wave[\s\S]*app-source-message-quote/);
  assert.match(markup, /data-quote-side="agent"/);
  assert.doesNotMatch(markup, /app-source-message-quote-rail/);
  assert.doesNotMatch(markup, /app-source-message-quote-icon/);
  assert.match(markup, />Me: <\/span>/);
  assert.match(markup, /app-message-mention-agent[^>]*>@AliceKordi<\/span>/);
  assert.doesNotMatch(markup, /app-source-message-quote-label block truncate/);
  assert.doesNotMatch(markup, /Replying to/);
  assert.match(markup, /review the copy/);
  assert.match(markup, /app-agent-waiting-wave/);
  assert.doesNotMatch(markup, /Processing/);
  assert.doesNotMatch(markup, /app-live-assistant-answer-markdown/);
  assert.doesNotMatch(markup, /checking auth screenshots/);
});

test('human quote renders as one line under the bubble on the bubble outer edge', () => {
  const baseMessage: Message = {
    id: 'msg-reply-own',
    role: 'user',
    senderType: 'human',
    isOwnMessage: true,
    text: 'Updated. The patch is small and covered by tests.',
    time: '10:44',
    sourceMessage: {
      messageId: 'msg-source',
      senderLabel: 'Maya',
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
      sender: 'Maya',
    },
  }));

  assert.match(ownMarkup, /app-chat-bubble-user[\s\S]*Updated\. The patch is small[\s\S]*data-quote-side="own"/);
  assert.match(peerMarkup, /app-chat-bubble-peer[\s\S]*Updated\. The patch is small[\s\S]*data-quote-side="peer"/);
  assert.match(ownMarkup, /justify-end pr-10"><button type="button" class="app-source-message-quote"/);
  assert.match(peerMarkup, /justify-start pl-10"><button type="button" class="app-source-message-quote"/);
  assert.match(ownMarkup, />Maya: <\/span>keep it concise/);
  assert.match(peerMarkup, />Maya: <\/span>keep it concise/);
  assert.match(ownMarkup, /title="Maya: keep it concise"/);
  assert.doesNotMatch(ownMarkup, /Replying to/);
  assert.doesNotMatch(peerMarkup, /Replying to/);
});

test('keeps long source quotes on one line with the full text in the tooltip', () => {
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
      senderLabel: 'Maya',
      text: [
        '@MayasKordi create a github issue about this bug.',
        'Use the current Kordi repo issue template and keep the reproduction details.',
        'Final acceptance detail should remain available in the tooltip.',
      ].join('\n'),
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));

  assert.match(markup, /title="Maya: @MayasKordi create a github issue about this bug\. Use the current Kordi repo issue template and keep the reproduction details\. Final acceptance detail should remain available in the tooltip\."/);
  assert.doesNotMatch(markup, /app-source-message-quote-folded|app-source-message-quote-toggle|Show full request/);
});

test('styles the source quote as a single muted line with a side bar', () => {
  const shellCss = readDesktopShellCss();
  const quoteRootBlock = shellCss.match(/\.app-source-message-quote \{[\s\S]*?\n\}/)?.[0] ?? '';
  const ownQuoteBlock = shellCss.match(/\.app-source-message-quote\[data-quote-side="own"\] \{[\s\S]*?\n\}/)?.[0] ?? '';
  const hoverBlock = shellCss.match(/\.app-source-message-quote:hover,\n\.app-source-message-quote:focus-visible \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(quoteRootBlock, /border-left:\s*2px solid var\(--app-source-message-quote-bar\)/);
  assert.match(quoteRootBlock, /background:\s*transparent/);
  assert.match(quoteRootBlock, /white-space:\s*nowrap/);
  assert.match(quoteRootBlock, /text-overflow:\s*ellipsis/);
  assert.match(quoteRootBlock, /font-size:\s*12px/);
  assert.match(ownQuoteBlock, /border-right:\s*2px solid var\(--app-source-message-quote-bar\)/);
  assert.match(ownQuoteBlock, /text-align:\s*right/);
  assert.match(hoverBlock, /--app-source-message-quote-bar:\s*var\(--app-chat-accent/);
  assert.doesNotMatch(shellCss, /\.app-source-message-quote-(?:link|toggle|folded|reveal-row)/);
});

test('styles reply attribution surfaces with stronger dark-mode contrast', () => {
  const shellCss = readDesktopShellCss();
  const responsePanelBlock = shellCss.match(/\.app-live-turn-response-panel \{[\s\S]*?\n\}/)?.[0] ?? '';
  const responseSurfaceBlock = shellCss.match(/\.app-live-assistant-answer-surface \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(responsePanelBlock, /var\(--app-control-bg\) 74%/);
  // Agent reply surface is intentionally flat: no border, no shadow, subtle fill.
  assert.match(responseSurfaceBlock, /border:\s*0/);
  assert.match(responseSurfaceBlock, /box-shadow:\s*none/);
  assert.match(responseSurfaceBlock, /background:\s*color-mix\(in oklab, var\(--utility-foreground\) 3%, transparent\)/);
});

test('keeps quoted mentions in the muted quote color', () => {
  const shellCss = readDesktopShellCss();
  const quoteMentionBlock = shellCss.match(/\.app-source-message-quote-text,\n\.app-source-message-quote \.app-message-mention \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(quoteMentionBlock, /color:\s*inherit/);
  assert.match(quoteMentionBlock, /font-weight:\s*inherit/);
  assert.doesNotMatch(shellCss, /\.app-chat-bubble-(?:user|peer) \.app-source-message-quote/);
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

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));

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

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));

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

  assert.doesNotMatch(transcriptSource, /Hide request|Show full request/);
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

const quoteToolAnswerSurfacePattern = /app-live-turn-response-panel app-live-assistant-answer-surface[\s\S]*app-transcript-tool-timeline[\s\S]*app-live-assistant-answer[\s\S]*<\/div><div class="flex min-w-0 max-w-full mt-1"><button type="button" class="app-source-message-quote" data-quote-side="agent"/;

test('keeps the tool summary inside the assistant response and the source quote under it', () => {
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
      senderLabel: 'Maya',
      text: '@MayasKordi create a github issue about this bug.',
      attachmentCount: 0,
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));

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

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn }));

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

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn }));

  assert.match(markup, /app-live-assistant-answer-content app-live-assistant-answer-folded/);
  assert.match(markup, /Show 2 more lines/);
  assert.doesNotMatch(markup, /— 2 more lines\. Click to show all —/);
});


for (const type of ['owned-agent', 'external-agent'] as const) {
  for (const completed of [false, true]) {
    test(`private ${type} hides raw reply references on the first ${completed ? 'history' : 'live'} render`, () => {
      const turn: DesktopChatTurnSnapshot = {
        id: 'private-turn', sessionId: 'private-agent-session', prompt: '',
        status: completed ? 'complete' : 'writing', message: '',
        assistantText: 'Synthetic direct answer', thinkingText: '', tools: [],
        completed, succeeded: completed,
        sourceMessage: { messageId: 'private-request', senderLabel: 'You', text: 'Synthetic request reference', attachmentCount: 0 },
      };
      const plainAgentResponse = shouldSuppressAgentReplyAttribution({ id: turn.sessionId, type, canonicalParticipantCount: 2 });
      const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: completed, plainAgentResponse }));
      assert.match(markup, /Synthetic direct answer/);
      assert.doesNotMatch(markup, /app-source-message-quote|Synthetic request reference/);
      assert.doesNotMatch(markup, /app-live-assistant-answer-surface/);
      assert.equal(turn.sourceMessage?.messageId, 'private-request', 'presentation must not mutate persisted reply linkage');
    });
  }
}
