import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DigestPeople } from '../src/features/digest/DigestPeople';
import type { DigestSource } from '../src/features/digest/types';

test('Digest attribution keeps owner messages and separates their agent from the human', () => {
  const source: DigestSource = { id: 'request', conversationId: 'room', sessionId: 'room', sessionTitle: 'Design review', senderAccountId: 'alex', senderName: 'Alex', text: '**Taylor**, bring the [prototype](https://example.com/prototype).', createdAt: '2026-09-05T10:00:00Z', version: 1 };
  const sources = [
    source,
    { ...source, id: 'reply', senderAccountId: 'taylor', senderName: 'Taylor', text: 'I will bring it.' },
    { ...source, id: 'agent', senderAccountId: 'taylor', senderName: 'Planning agent', agentId: 'cloud-agent:taylor', agentOwnerName: 'Taylor', isAgent: true, text: 'I summarized the plan.' },
    { ...source, id: 'unrelated', senderName: 'Unrelated', text: 'Unrelated message.' },
  ];
  const html = renderToStaticMarkup(createElement(DigestPeople, { item: { sourceIds: ['request', 'reply', 'agent'], ownerAccountId: 'taylor' }, sources, accountId: 'taylor', showMessages: true }));
  assert.equal((html.match(/class="digest-person"/g) ?? []).length, 3);
  assert.ok(!html.includes('Mentioned by'));
  assert.ok(!html.includes('<small>'));
  assert.equal((html.match(/<blockquote>/g) ?? []).length, 3);
  assert.ok(html.includes('@You'));
  assert.ok(html.includes('@Planning agent'));
  assert.ok(html.includes('Owner · You'));
  assert.ok(!html.includes('Agent for Taylor'));
  assert.ok(html.includes('I will bring it.'));
  assert.ok(!html.includes('Unrelated message.'));
  assert.match(html, /<strong[^>]*>Taylor<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/prototype"/);
});

test('Digest renders canonical human and agent avatars separately, including owner-only chips', () => {
  const source: DigestSource = { id: 'human', conversationId: 'room', sessionId: 'room', sessionTitle: 'Planning', senderAccountId: 'alex', senderName: 'Alex', text: 'A note.', createdAt: '2026-09-08T00:00:00Z', version: 1, senderAvatarUrl: 'https://example.com/human.jpg' };
  const agent: DigestSource = { ...source, id: 'agent', senderName: 'Helper', isAgent: true, agentId: 'helper', agentOwnerName: 'Alex', agentAvatarUrl: 'https://example.com/agent.jpg' };
  const render = (sourceIds: string[], ownerAccountId?: string) => renderToStaticMarkup(createElement(DigestPeople, { item: { sourceIds, ownerAccountId }, sources: [source, agent], accountId: 'viewer' }));
  const human = render(['human']);
  assert.match(human, /src="https:\/\/example.com\/human.jpg"/);
  assert.doesNotMatch(human, /src="https:\/\/example.com\/agent.jpg"/);
  const agentOnly = render(['agent']);
  assert.match(agentOnly, /src="https:\/\/example.com\/agent.jpg"/);
  assert.doesNotMatch(agentOnly, /src="https:\/\/example.com\/human.jpg"/);
  const owner = render(['agent'], 'alex');
  assert.match(owner, /src="https:\/\/example.com\/human.jpg"/);
  assert.match(owner, /src="https:\/\/example.com\/agent.jpg"/);
  source.senderAvatarUrl = 'https://example.com/updated.jpg';
  assert.match(render(['human']), /src="https:\/\/example.com\/updated.jpg"/);
  agent.agentAvatarUrl = null;
  assert.doesNotMatch(render(['agent']), /src="https:\/\/example.com\/(human|updated).jpg"/);
});
