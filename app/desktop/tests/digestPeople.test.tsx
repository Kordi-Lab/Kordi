import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DigestPeople } from '../src/features/digest/DigestPeople';
import type { DigestSource } from '../src/features/digest/types';

test('Digest attribution keeps owner messages and separates their agent from the human', () => {
  const source: DigestSource = { id: 'request', conversationId: 'room', sessionId: 'room', sessionTitle: 'Design review', senderAccountId: 'alex', senderName: 'Alex', text: 'Taylor, bring the prototype.', createdAt: '2026-09-05T10:00:00Z', version: 1 };
  const sources = [
    source,
    { ...source, id: 'reply', senderAccountId: 'taylor', senderName: 'Taylor', text: 'I will bring it.' },
    { ...source, id: 'agent', senderAccountId: 'taylor', senderName: 'Planning agent', isAgent: true, text: 'I summarized the plan.' },
    { ...source, id: 'unrelated', senderName: 'Unrelated', text: 'Unrelated message.' },
  ];
  const html = renderToStaticMarkup(createElement(DigestPeople, { item: { sourceIds: ['request', 'reply', 'agent'], ownerAccountId: 'taylor' }, sources, accountId: 'taylor', showMessages: true }));
  assert.equal((html.match(/class="digest-person"/g) ?? []).length, 3);
  assert.equal((html.match(/Owner · Mentioned by/g) ?? []).length, 1);
  assert.equal((html.match(/<blockquote>/g) ?? []).length, 3);
  assert.ok(html.includes('@You'));
  assert.ok(html.includes('@Planning agent'));
  assert.ok(html.includes('I will bring it.'));
  assert.ok(!html.includes('Unrelated message.'));
});
