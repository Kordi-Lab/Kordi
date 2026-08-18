import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadWhatsNewRelease,
  markWhatsNewPresented,
  parseWhatsNewRelease,
  releaseHighlightGroups,
  releaseHighlights,
  WHATS_NEW_LAST_SHOWN_VERSION_KEY,
  whatsNewRequestUrl,
} from '../src/features/updates/whatsNew';

const VERSION = '0.0.1-beta.13';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(key) ?? null; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(key); },
    setItem(key: string, value: string) { values.set(key, value); },
  } satisfies Storage;
}

function releaseMetadata(version = VERSION) {
  return {
    schemaVersion: 1,
    version,
    notes: '### Added\n\n- Added a first-launch summary. ([#893])',
    pubDate: '2026-08-18T00:00:00Z',
    changelogUrl: 'https://github.com/Kordi-Lab/Kordi/releases/tag/V0.0.1.beta13',
  };
}

function metadataFetch(metadata = releaseMetadata()) {
  let calls = 0;
  return {
    get calls() { return calls; },
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

test('first launch loads exact-version metadata and marks it only after presentation', async () => {
  const storage = memoryStorage();
  const request = metadataFetch();
  const release = await loadWhatsNewRelease({
    isNativeShell: true,
    currentVersion: async () => VERSION,
    fetchImpl: request.fetch,
    baseUrl: 'https://kordi.ai',
    storage,
  });

  assert.equal(request.calls, 1);
  assert.equal(release?.version, VERSION);
  assert.equal(storage.getItem(WHATS_NEW_LAST_SHOWN_VERSION_KEY), null);
  assert.ok(release);
  assert.equal(markWhatsNewPresented(release, storage), true);
  assert.equal(storage.getItem(WHATS_NEW_LAST_SHOWN_VERSION_KEY), VERSION);
});

test('repeat launch skips metadata for the exact version already shown', async () => {
  const storage = memoryStorage({ [WHATS_NEW_LAST_SHOWN_VERSION_KEY]: VERSION });
  const request = metadataFetch();
  const release = await loadWhatsNewRelease({
    isNativeShell: true,
    currentVersion: async () => VERSION,
    fetchImpl: request.fetch,
    baseUrl: 'https://kordi.ai',
    storage,
  });

  assert.equal(release, null);
  assert.equal(request.calls, 0);
});

test('an installed version change makes What’s New eligible again', async () => {
  const storage = memoryStorage({
    [WHATS_NEW_LAST_SHOWN_VERSION_KEY]: '0.0.1-beta.11',
  });
  const request = metadataFetch();
  const release = await loadWhatsNewRelease({
    isNativeShell: true,
    currentVersion: async () => VERSION,
    fetchImpl: request.fetch,
    baseUrl: 'http://127.0.0.1:17081',
    storage,
  });

  assert.equal(release?.version, VERSION);
  assert.equal(request.calls, 1);
  assert.equal(storage.getItem(WHATS_NEW_LAST_SHOWN_VERSION_KEY), '0.0.1-beta.11');
});

test('metadata failure never blocks launch or advances the stored version', async () => {
  const storage = memoryStorage({
    [WHATS_NEW_LAST_SHOWN_VERSION_KEY]: '0.0.1-beta.11',
  });
  const release = await loadWhatsNewRelease({
    isNativeShell: true,
    currentVersion: async () => VERSION,
    fetchImpl: async () => { throw new Error('offline'); },
    baseUrl: 'https://kordi.ai',
    storage,
  });

  assert.equal(release, null);
  assert.equal(storage.getItem(WHATS_NEW_LAST_SHOWN_VERSION_KEY), '0.0.1-beta.11');
});

test('browser mode and malformed release metadata fail closed', async () => {
  const request = metadataFetch(releaseMetadata('0.0.1-beta.99'));
  assert.equal(await loadWhatsNewRelease({
    isNativeShell: false,
    currentVersion: async () => VERSION,
    fetchImpl: request.fetch,
    baseUrl: 'https://kordi.ai',
  }), null);
  assert.equal(request.calls, 0);
  assert.equal(parseWhatsNewRelease(releaseMetadata('0.0.1-beta.99'), VERSION), null);
});

test('release metadata and highlights stay safe and readable', () => {
  assert.equal(
    whatsNewRequestUrl(VERSION, 'https://kordi.ai'),
    `https://kordi.ai/updates/releases/${VERSION}/metadata`,
  );
  assert.deepEqual(
    releaseHighlightGroups([
      '### Added',
      '',
      '- Added **What’s New** after upgrades. ([#893])',
      '',
      '### Fixed',
      '',
      '- Kept `startup` available when metadata fails.',
    ].join('\n')),
    [
      { title: 'Added', items: ['Added What’s New after upgrades.'] },
      { title: 'Fixed', items: ['Kept startup available when metadata fails.'] },
    ],
  );
  assert.equal(
    parseWhatsNewRelease({
      ...releaseMetadata(),
      changelogUrl: 'javascript:alert(1)',
    }, VERSION)?.changelogUrl,
    undefined,
  );
});

test('beta.13 uses the four customer-facing release highlights', () => {
  const release = parseWhatsNewRelease(releaseMetadata(), VERSION);
  assert.ok(release);
  assert.deepEqual(releaseHighlights(release), [
    {
      category: 'iPhone companion',
      title: 'Your chats, agents, calls, and media now travel with you',
      detail: 'The native iPhone app now includes Contact and Agent conversations, Digest, Ask Agent, calls, session details, expressive media, profiles, and presence.',
      kind: 'general',
    },
    {
      category: 'Reliable collaboration',
      title: 'Chats and agent work converge cleanly across devices',
      detail: 'Reliable sync v2 keeps messages, group handoffs, agent replies, read state, and runtime routes consistent without duplicate execution.',
      kind: 'collaboration',
    },
    {
      category: 'Calls and devices',
      title: 'Review active devices and start native calls',
      detail: 'Manage signed-in installations and use synchronized audio, video, and group-call history across macOS and iOS.',
      kind: 'collaboration',
    },
    {
      category: 'Chat polish',
      title: 'Messages stay compact, readable, and correctly delivered',
      detail: 'Refined composer behavior, mentions, partial agent output, receipts, media previews, scrolling, timestamps, and expandable tool activity.',
      kind: 'general',
    },
  ]);
});

test('other releases fall back to clean, bounded Markdown highlights', () => {
  assert.deepEqual(releaseHighlights({
    version: '0.0.1-beta.99',
    notes: '### Added\n\n- Added **What’s New** after upgrades. ([#893])\n- Kept `startup` available when metadata fails.',
    publishedAt: '2026-08-09T00:00:00Z',
  }), [
    { category: 'Added', title: 'Added What’s New after upgrades.', kind: 'general' },
    { category: 'Added', title: 'Kept startup available when metadata fails.', kind: 'general' },
  ]);
});
