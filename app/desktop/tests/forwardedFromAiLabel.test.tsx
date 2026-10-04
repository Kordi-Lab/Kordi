import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ForwardedFromHeader } from '../src/kordi-app/components/forwardedFromHeader';
import { SourceMessageQuote } from '../src/kordi-app/components/transcriptReplyAttribution';

test('forwarded agent messages name the sender with an AI label', () => {
  const agent = renderToStaticMarkup(createElement(ForwardedFromHeader, { senderLabel: 'Scout', sourceMessageKind: 'agent-turn' }));
  assert.match(agent, /Forwarded from/);
  assert.match(agent, />Scout \(AI\)</);
  const person = renderToStaticMarkup(createElement(ForwardedFromHeader, { senderLabel: 'Bea', sourceMessageKind: 'text' }));
  assert.match(person, />Bea</);
  assert.doesNotMatch(person, /\(AI\)/);
  const legacy = renderToStaticMarkup(createElement(ForwardedFromHeader, { senderLabel: 'Bea' }));
  assert.doesNotMatch(legacy, /\(AI\)/);
});

test('quoted agent messages carry the AI label; quoted people do not', () => {
  const quote = (sourceMessageKind: string | null) => renderToStaticMarkup(createElement(SourceMessageQuote, {
    sourceMessage: { messageId: 'msg:1', senderLabel: 'Scout', sourceMessageKind, text: 'Saturday works' },
  }));
  assert.match(quote('agent-turn'), /Scout \(AI\)/);
  assert.doesNotMatch(quote('text'), /\(AI\)/);
  assert.doesNotMatch(quote(null), /\(AI\)/);
});
