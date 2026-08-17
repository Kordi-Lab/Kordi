import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContactRequestRow, LiveChatTurnCard, MessageBubble } from '../src/kordi-app/components/transcript';
import { formatDesktopContactRequestTimeLabel } from '../src/lib/time';
import type { ContactRequest, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

test('transcript human avatars are large enough to read beside message bubbles', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const avatarStart = source.indexOf('{showAvatar ? (');
  const avatarEnd = source.indexOf('{forwardedSource ?', avatarStart);
  assert.ok(avatarStart >= 0 && avatarEnd > avatarStart, 'message avatar rendering block should be present');
  const avatarBlock = source.slice(avatarStart, avatarEnd);
  const avatarSizeContract = /useHumanCompactDensity \? 'h-7 w-7' : 'h-8 w-8'/g;

  assert.ok((avatarBlock.match(avatarSizeContract) ?? []).length >= 2, 'both clickable and static message avatars should retain the readable size contract');
  assert.doesNotMatch(avatarBlock, /h-5\.5 w-5\.5/);
});

test('expanded thinking content uses a compact secondary type scale relative to the final answer', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcriptLiveTurns.tsx', import.meta.url), 'utf8');
  const answerSource = readFileSync(new URL('../src/kordi-app/components/transcriptAssistantAnswer.tsx', import.meta.url), 'utf8');
  const timelineStyles = readFileSync(new URL('../src/styles/shell-transcript-timeline.css', import.meta.url), 'utf8');
  const answerStart = answerSource.indexOf('export function FoldableAssistantAnswer');
  const thinkingStart = source.indexOf('function ToolTimelineThinkingRow');
  const thinkingEnd = source.indexOf('function useRunningElapsedLabel', thinkingStart);
  assert.ok(answerStart >= 0, 'expected FoldableAssistantAnswer source block');
  assert.ok(thinkingStart >= 0 && thinkingEnd > thinkingStart, 'expected ToolTimelineThinkingRow source block');
  const answerBlock = answerSource.slice(answerStart);
  const thinkingBlock = source.slice(thinkingStart, thinkingEnd);

  assert.match(answerBlock, /app-live-assistant-answer w-full text-\[13px\]/);
  assert.match(thinkingBlock, /app-transcript-thinking-markdown/);
  assert.doesNotMatch(thinkingBlock, /leading-\[1\.55rem\]|text-\[1[234](?:\.5)?px\]/);
  assert.match(timelineStyles, /\.app-transcript-thinking-markdown\s*\{[^}]*font-size:\s*0\.75rem;[^}]*line-height:\s*1\.55;/s);
  assert.match(timelineStyles, /\.app-transcript-thinking-markdown :where\(p, li, blockquote, td, th\)\s*\{[^}]*font-size:\s*inherit;[^}]*line-height:\s*inherit;/s);
});

test('code blocks remove the header bar and reveal copy controls on hover', () => {
  const markdownSource = readFileSync(new URL('../src/kordi-app/components/markdown.tsx', import.meta.url), 'utf8');
  const liveTurnsSource = readFileSync(new URL('../src/kordi-app/components/transcriptLiveTurns.tsx', import.meta.url), 'utf8');
  const themeTokensSource = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const codeBlockStart = markdownSource.indexOf('function MarkdownCodeBlock');
  const codeBlockEnd = markdownSource.indexOf('function MarkdownListView', codeBlockStart);
  const transcriptBlockStart = liveTurnsSource.indexOf('function ToolTranscriptBlock');
  const transcriptBlockEnd = liveTurnsSource.indexOf('function toolDisplayConfig', transcriptBlockStart);
  assert.ok(codeBlockStart >= 0 && codeBlockEnd > codeBlockStart, 'expected MarkdownCodeBlock source block');
  assert.ok(transcriptBlockStart >= 0 && transcriptBlockEnd > transcriptBlockStart, 'expected ToolTranscriptBlock source block');
  const codeBlock = markdownSource.slice(codeBlockStart, codeBlockEnd);
  const transcriptBlock = liveTurnsSource.slice(transcriptBlockStart, transcriptBlockEnd);

  assert.match(markdownSource, /import \{ Check, Copy \} from 'lucide-react';/);
  assert.doesNotMatch(codeBlock, /app-markdown-code-header/);
  assert.match(codeBlock, /group relative max-w-full/);
  assert.match(codeBlock, /rounded-\[10px\]/);
  assert.doesNotMatch(codeBlock, /rounded-\[18px\]/);
  assert.match(codeBlock, /<span className="sr-only" data-kordi-copy-exclude="true">\{resolvedLanguage\}<\/span>/);
  assert.doesNotMatch(codeBlock, />\{resolvedLanguage\}<\/div>/);
  assert.match(codeBlock, /app-markdown-code-copy-button[^"']*absolute[^"']*opacity-0[^"']*group-hover:opacity-100[^"']*group-focus-within:opacity-100/);
  assert.doesNotMatch(codeBlock, />\{copied \? 'Copied' : 'Copy'\}</);
  assert.match(themeTokensSource, /--app-code-bg: #eef1f5;/);
  assert.doesNotMatch(themeTokensSource, /--app-code-bg: #ede8e1;/);
  assert.match(transcriptBlock, /WrapText/);
  assert.match(transcriptBlock, /aria-label=\{isWrapped \? 'Disable line wrapping' : 'Wrap long lines'\}/);
  assert.match(transcriptBlock, /app-transcript-wrap-toggle[^"']*h-6 w-6/);
  assert.doesNotMatch(transcriptBlock, />\{isWrapped \? 'No wrap' : 'Wrap'\}</);
});

test('agent waiting state uses a waveform only until the first response content arrives', () => {
  const waitingTurn: DesktopChatTurnSnapshot = {
    id: 'turn-waiting-first-token',
    sessionId: 'session-1',
    prompt: 'hello',
    status: 'starting',
    message: 'Thinking…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
  };
  const waitingMarkup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn: waitingTurn,
    onStopActiveTurn: () => undefined,
  }));

  assert.match(waitingMarkup, /app-agent-waiting-wave/);
  assert.match(waitingMarkup, /aria-label="Waiting for agent response"/);
  assert.doesNotMatch(waitingMarkup, />Thinking…</);

  const streamingMarkup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn: { ...waitingTurn, status: 'writing', assistantText: 'H' },
    onStopActiveTurn: () => undefined,
  }));
  assert.doesNotMatch(streamingMarkup, /app-agent-waiting-wave/);
});

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

test('completed activity summary renders before the final assistant result', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-answer-first',
    sessionId: 'session-1',
    prompt: 'hello',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Primary answer',
    thinkingText: '',
    tools: [{
      id: 'tool-1',
      name: 'read',
      status: 'done',
      arguments: '{}',
      liveOutput: '',
      resultText: 'done',
      detail: null,
      isError: false,
    }],
    completed: true,
    succeeded: true,
    startedAtMs: 1_725_000_000_000,
    completedAtMs: 1_725_000_352_000,
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, historical: true }));
  const answerIndex = markup.indexOf('Primary answer');
  const toolsIndex = markup.indexOf('app-transcript-tool-timeline');

  assert.ok(answerIndex >= 0);
  assert.ok(toolsIndex >= 0);
  assert.ok(toolsIndex < answerIndex, 'completed activity should remain above the final answer');
  assert.match(markup, /Worked for 5m 52s/);
  assert.match(markup, /data-transcript-stable-disclosure="true"/);
  const timelineSource = readFileSync(new URL('../src/kordi-app/components/transcriptLiveTurns.tsx', import.meta.url), 'utf8');
  const timelineStart = timelineSource.indexOf('function FoldableToolTimeline');
  const timelineEnd = timelineSource.indexOf('function longerText', timelineStart);
  const timelineBlock = timelineSource.slice(timelineStart, timelineEnd);
  const timelineStyles = readFileSync(new URL('../src/styles/shell-transcript-timeline.css', import.meta.url), 'utf8');
  assert.ok(
    timelineBlock.indexOf('app-transcript-tool-timeline-row') < timelineBlock.indexOf('app-transcript-timeline-list'),
    'expanded activity should unfold below its stable summary control',
  );
  assert.match(timelineBlock, /app-transcript-timeline-reveal-open/);
  assert.match(timelineStyles, /\.app-transcript-timeline-reveal\s*\{[^}]*grid-template-rows:\s*0fr;[^}]*transition:\s*grid-template-rows/s);
  assert.match(timelineStyles, /\.app-transcript-timeline-reveal-open\s*\{[^}]*grid-template-rows:\s*1fr;/s);
  assert.match(timelineStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.app-transcript-timeline-reveal/);
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
  assert.match(markup, /app-message-mention-agent[^>]*>@MyKordi<\/span>/);
  assert.match(markup, /what are you doing/);
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
    onAccept: () => undefined,
    onReject: () => undefined,
    actionState: 'accepting',
  }));

  assert.match(markup, />Accepting…</);
  assert.match(markup, />Accepting and sending greeting…</);
  assert.match(markup, /animate-spin/);
  assert.match(markup, /disabled=""/);
});

test('contact request row formats transport timestamps for people', () => {
  const request: ContactRequest = {
    id: 'request-time',
    initials: 'SY',
    title: 'Shu Yang wants to connect',
    detail: 'Contact request',
    time: '2026-08-13T10:22:12.663250538+00:00',
  };

  const markup = renderToStaticMarkup(createElement(ContactRequestRow, {
    request,
    active: false,
  }));

  assert.match(markup, new RegExp(formatDesktopContactRequestTimeLabel(request.time)));
  assert.doesNotMatch(markup, />2026-08-13T10:22:12/);
});

test('renders bridge agent stop control beside the first-response waveform', () => {
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
    pendingCollaborationAgentRequest: {
      conversationId: 'bridge:host-1:node-agent',
      requestId: 'bridge_req_stop',
    },
  };

  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn,
    onStopCollaborationAgentRequest: () => undefined,
  }));

  assert.match(markup, /aria-label="Stop agent request"/);
  assert.match(markup, /title="Stop agent request"/);
  assert.match(markup, /app-collaboration-agent-stop-button/);
  assert.match(markup, /h-\[18px\] w-\[18px\]/);
  assert.match(markup, /text-slate-400/);
  assert.doesNotMatch(markup, /h-5\.5 w-5\.5/);
  assert.match(markup, /app-agent-waiting-wave/);
  assert.doesNotMatch(markup, />Processing…</);
});

test('empty pending agent turn renders the waiting waveform with its source quote', () => {
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
  assert.match(markup, /app-message-mention-agent[^>]*>@MyKordi<\/span>/);
  assert.match(markup, /what are you doing/);
  assert.match(markup, /app-agent-waiting-wave/);
  assert.doesNotMatch(markup, />Starting…</);
});

test('renders initial generic working status as a waveform until real content appears', () => {
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

  assert.match(markup, /app-agent-waiting-wave/);
  assert.doesNotMatch(markup, />Starting…</);
  assert.doesNotMatch(markup, /Planning…/);
  assert.doesNotMatch(markup, />Working…</);
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
  assert.match(markup, /data-message-media-side="own"/);
  assert.match(markup, /p-0/);
  assert.match(markup, /bg-transparent/);
  assert.match(markup, /shadow-none/);
  assert.doesNotMatch(markup, /app-message-bubble-shape/);
  assert.doesNotMatch(markup, /app-message-footer/);
  assert.doesNotMatch(markup, /px-4 py-2\.5/);
});

test('image-only messages align their outside edge with the matching text bubble tail', () => {
  const peerMessage: Message = {
    role: 'person',
    sender: 'Shu Yang',
    senderType: 'human',
    isOwnMessage: false,
    text: '',
    time: '21:10',
    attachments: [{
      kind: 'image',
      name: 'Received screenshot.png',
      previewUrl: 'https://files.test/received.png',
      mimeType: 'image/png',
    }],
  };
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: peerMessage }));
  const stylesheet = readFileSync(new URL('../src/styles/shell-bubbles.css', import.meta.url), 'utf8');

  assert.match(markup, /data-message-media-side="peer"/);
  assert.match(stylesheet, /\[data-message-media-side="own"\]\s*{[^}]*translateX\(var\(--app-message-media-edge-offset\)\)/s);
  assert.match(stylesheet, /\[data-message-media-side="peer"\]\s*{[^}]*translateX\(calc\(-1 \* var\(--app-message-media-edge-offset\)\)\)/s);
  assert.match(stylesheet, /\[data-message-media-side="own"\] \.app-attachment-image-collage\s*{[^}]*align-self:\s*flex-end;/s);
  assert.match(stylesheet, /\[data-message-media-side="peer"\] \.app-attachment-image-collage\s*{[^}]*align-self:\s*flex-start;/s);
});

test('pending image attachments reserve a compact image-sized loading placeholder', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '',
    time: '21:09',
    statusChips: ['sending'],
    attachments: [{
      kind: 'image',
      name: 'Screenshot loading.png',
      mimeType: 'image/png',
    }],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /data-attachment-image-loading="true"/);
  assert.match(markup, /w-\[min\(100%,20rem\)\]/);
  assert.match(markup, /auto-rows-\[4rem\]/);
  assert.match(markup, /aspect-\[4\/3\]/);
  assert.doesNotMatch(markup, /data-attachment-file-card="true"/);
  assert.doesNotMatch(markup, /w-\[min\(100%,29rem\)\][^"]*auto-rows-\[6\.5rem\]/);
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
