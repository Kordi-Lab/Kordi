import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

test('renders a compact linked agent session beneath the normal parent response', () => {
  const message: Message = {
    id: 'parent-response',
    entryId: 'parent-entry',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: '',
    time: '10:42',
    turn: {
      id: 'parent-turn',
      sessionId: 'group-session',
      prompt: 'Research this deeply',
      status: 'complete',
      message: 'Complete',
      assistantText: 'I started the deeper review in a background session.',
      thinkingText: '',
      tools: [{
        id: 'spawn-tool',
        name: 'task_operator',
        status: 'done',
        arguments: '{"action":"spawn"}',
        liveOutput: '',
        resultText: 'Task agent running: /root/review\n\nBackground session: {"sessionId":"child-session","turnId":"child-turn","title":"Review subagent orchestration","status":"running"}',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning_coordination',
        isError: false,
      }],
      completed: true,
      succeeded: true,
      error: null,
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    onOpenForkSession: () => undefined,
    relatedAgentSessionStatusById: new Map([['child-session', 'failed']]),
  }));

  assert.match(markup, /I started the deeper review in a background session\./);
  assert.match(markup, /data-related-agent-sessions="true"/);
  assert.match(markup, /data-related-agent-session-style="thread-preview"/);
  assert.match(markup, /data-related-agent-session-id="child-session"/);
  assert.match(markup, /Open background agent session: Review subagent orchestration/);
  assert.match(markup, /min-h-10/);
  assert.match(markup, />My Kordi</);
  assert.match(markup, />Background session</);
  assert.match(markup, /data-related-agent-session-status="failed"/);
  assert.match(markup, />Failed</);
  assert.doesNotMatch(markup, /min-h-11/);
  assert.doesNotMatch(markup, /Open work thread/);
});
