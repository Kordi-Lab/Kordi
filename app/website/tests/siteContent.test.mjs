import assert from 'node:assert/strict';
import test from 'node:test';

import { siteContent } from '../src/content.js';
import { renderSite } from '../src/renderSite.js';

test('hero uses the approved sentence case headline', () => {
  assert.equal(siteContent.hero.title, 'AI agent infrastructure for Super Collaboration');
  assert.notEqual(siteContent.hero.title, siteContent.hero.title.toUpperCase());
});

test('rendered page contains the core PR page sections and first blog title', () => {
  const html = renderSite(siteContent);

  assert.match(html, /id="mission"/);
  assert.match(html, /id="system"/);
  assert.match(html, /id="journal"/);
  assert.match(html, /How did we build a supercollaboration system to help our team build the supercollaboration system\?/);
});

test('hero does not repeat the Kordi AI brand label', () => {
  const html = renderSite(siteContent);
  const hero = html.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? '';

  assert.doesNotMatch(hero, /Kordi AI/);
});
