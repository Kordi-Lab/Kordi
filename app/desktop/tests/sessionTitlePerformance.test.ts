import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('session title derivation reuses one Intl.Segmenter instance', () => {
  const source = readFileSync(
    new URL('../src/features/chat/sessionTitlePolicy.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const graphemeSegmenter = Segmenter/);
  assert.doesNotMatch(
    source,
    /function graphemes[\s\S]*?new Segmenter/,
    'title derivation must not construct an ICU segmenter for every message',
  );
  assert.match(
    source,
    /if \(value\.length <= MAX_SESSION_TITLE_GRAPHEMES\) return value;/,
    'short titles must bypass ICU segmentation entirely',
  );
  assert.match(
    source,
    /const sessionTitleCache = new Map<string, string \| null>\(\);/,
    'repeated read-model builds must reuse title derivation results',
  );
  assert.match(
    source,
    /if \(sessionTitleCache\.size > SESSION_TITLE_CACHE_LIMIT\)/,
    'the title cache must stay bounded',
  );
});

test('first-message title selection scans without allocating filtered message arrays', () => {
  const source = readFileSync(
    new URL('../src/features/canonical/readModel/conversationMapping.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function firstMessageTitle');
  const end = source.indexOf('\nfunction legacyFirstMessageTitle', start);
  const implementation = source.slice(start, end);

  assert.match(implementation, /for \(const message of messages\)/);
  assert.doesNotMatch(implementation, /\.filter\(/);
  assert.doesNotMatch(implementation, /\.\.\.visible/);
});
