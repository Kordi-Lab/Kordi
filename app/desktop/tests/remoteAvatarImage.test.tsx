import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  getLocalAgentAvatarSeed,
  getIdentityAvatarKey,
  IdentityAvatar,
} from '../src/kordi-app/components/IdentityAvatar';
import {
  clearRemoteAvatarImageCacheForTests,
  getRemoteAvatarImageCacheStatsForTests,
  getRemoteAvatarImageSnapshot,
  loadAvatarThroughNativeProxy,
  loadRemoteImageThroughNativeProxy,
  shouldLoadAvatarThroughNativeProxy,
} from '../src/kordi-app/components/remoteAvatarImage';

function installNativeDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://desktop.kordi.test',
  });
  Object.defineProperty(dom.window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

test('native desktop routes remote HTTPS avatars through its proxy-aware image loader', () => {
  assert.equal(shouldLoadAvatarThroughNativeProxy('https://images.example/avatar.png', true), true);
  assert.equal(shouldLoadAvatarThroughNativeProxy('data:image/png;base64,avatar', true), false);
  assert.equal(shouldLoadAvatarThroughNativeProxy('https://images.example/avatar.png', false), false);
  assert.equal(shouldLoadAvatarThroughNativeProxy('http://127.0.0.1:17185/avatar.png', true), false);
  assert.equal(
    shouldLoadAvatarThroughNativeProxy('http://127.0.0.1:17185/blob.webp', true, true, true),
    true,
  );
  assert.equal(
    shouldLoadAvatarThroughNativeProxy('http://localhost:17185/blob.webp', true, true, true),
    false,
  );
});

test('remote avatar image requests share one native load per URL', async () => {
  clearRemoteAvatarImageCacheForTests();
  const calls: Array<{ command: string; url: unknown }> = [];
  const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, url: args?.url });
    return 'data:image/png;base64,avatar' as T;
  };

  const first = loadAvatarThroughNativeProxy(' https://images.example/avatar.png ', invoke);
  const second = loadAvatarThroughNativeProxy('https://images.example/avatar.png', invoke);

  assert.equal(await first, 'data:image/png;base64,avatar');
  assert.equal(await second, 'data:image/png;base64,avatar');
  assert.deepEqual(calls, [{
    command: 'desktop_fetch_remote_image_data_url',
    url: 'https://images.example/avatar.png',
  }]);
});

test('content-addressed image requests share their native integrity-checked load', async () => {
  clearRemoteAvatarImageCacheForTests();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return 'data:image/webp;base64,ZW1vamk=' as T;
  };
  const url = 'https://images.example/blob.webp';
  const expectedSha256 = 'a'.repeat(64);
  const options = { command: 'desktop_fetch_blob_emoji_data_url' as const, expectedSha256 };

  const first = loadRemoteImageThroughNativeProxy(url, options, invoke);
  const second = loadRemoteImageThroughNativeProxy(url, options, invoke);
  assert.equal(await first, await second);
  assert.deepEqual(calls, [{
    command: 'desktop_fetch_blob_emoji_data_url',
    args: { url, expectedSha256 },
  }]);
});

test('failed remote avatar image requests enter a retry cooldown', async () => {
  clearRemoteAvatarImageCacheForTests();
  let attempts = 0;
  const invoke = async <T,>(): Promise<T> => {
    attempts += 1;
    throw new Error('offline');
  };

  await assert.rejects(loadAvatarThroughNativeProxy('https://images.example/retry.png', invoke));
  await assert.rejects(
    loadAvatarThroughNativeProxy('https://images.example/retry.png', invoke),
    /offline/,
  );
  assert.equal(attempts, 1);
  assert.equal(
    getRemoteAvatarImageSnapshot('https://images.example/retry.png').status,
    'failed',
  );
});

test('native avatar failures do not authorize a renderer-side URL fallback', () => {
  const avatarSource = readFileSync(new URL('../src/kordi-app/components/IdentityAvatar.tsx', import.meta.url), 'utf8');
  const loaderSource = readFileSync(new URL('../src/kordi-app/components/remoteAvatarImage.ts', import.meta.url), 'utf8');

  assert.match(avatarSource, /remoteAvatar\.status === 'ready' \? remoteAvatar\.dataUrl : null/);
  assert.match(loaderSource, /desktop_fetch_remote_image_data_url/);
  assert.doesNotMatch(avatarSource, /remoteAvatar\.status === 'failed'[^\n]+originalImageUrl/);
});

test('generated agent avatars use the canonical Thumbs renderer', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/IdentityAvatar.tsx', import.meta.url), 'utf8');

  assert.equal(getLocalAgentAvatarSeed(), 'cloud-local-agent');
  assert.match(source, /generatedAvatarPreviewUrl\([\s\S]*AGENT_CANONICAL_AVATAR_STYLE/);
  assert.doesNotMatch(source, /AgentIdenticonAvatar|shapeRendering="crispEdges"/);
});

test('agent avatar keys preserve their canonical model identity', () => {
  assert.equal(getIdentityAvatarKey('agent', 'local:123'), 'agent:local:123');
  assert.equal(getIdentityAvatarKey('agent', 'local:123', 'agent:local:123'), 'agent:local:123');
});

test('resolved remote avatars stay within a byte-budgeted LRU cache', async () => {
  clearRemoteAvatarImageCacheForTests();
  const calls = new Map<string, number>();
  const payload = `data:image/png;base64,${'a'.repeat(1_000_000)}`;
  const invoke = async <T,>(_command: string, args?: Record<string, unknown>): Promise<T> => {
    const url = String(args?.url ?? '');
    calls.set(url, (calls.get(url) ?? 0) + 1);
    return payload as T;
  };

  for (let index = 0; index < 32; index += 1) {
    await loadAvatarThroughNativeProxy(`https://images.example/avatar-${index}.png`, invoke);
  }

  const stats = getRemoteAvatarImageCacheStatsForTests();
  assert.ok(stats.totalBytes <= stats.maxBytes);
  assert.ok(stats.entries < 32, 'the byte budget should evict old resolved avatars');

  await loadAvatarThroughNativeProxy('https://images.example/avatar-0.png', invoke);
  assert.equal(calls.get('https://images.example/avatar-0.png'), 2, 'reading an evicted URL should fetch it again');
});

test('a single result larger than the cache budget is returned but not retained', async () => {
  clearRemoteAvatarImageCacheForTests();
  let calls = 0;
  const maxBytes = getRemoteAvatarImageCacheStatsForTests().maxBytes;
  const invoke = async <T,>(): Promise<T> => {
    calls += 1;
    return `data:image/png;base64,${'a'.repeat(Math.floor(maxBytes / 2) + 1)}` as T;
  };

  const url = 'https://images.example/too-large-to-cache.png';
  await loadAvatarThroughNativeProxy(url, invoke);
  await loadAvatarThroughNativeProxy(url, invoke);

  assert.equal(calls, 2);
  assert.equal(getRemoteAvatarImageCacheStatsForTests().entries, 0);
});

test('known native avatars render a neutral first frame instead of generated identity art', () => {
  const installed = installNativeDom();
  clearRemoteAvatarImageCacheForTests();

  try {
    const markup = renderToStaticMarkup(
      <IdentityAvatar
        kind="human"
        seed="acct_alex"
        name="Alex Morgan"
        imageUrl="https://images.example/taylor.png"
      />,
    );

    assert.match(markup, /data-avatar-state="pending"/);
    assert.doesNotMatch(markup, />SH</);
    assert.doesNotMatch(markup, /src="https:\/\/images\.example\/taylor\.png"/);
  } finally {
    installed.restore();
  }
});

test('a memory-cached native avatar is present on the first render', async () => {
  const installed = installNativeDom();
  clearRemoteAvatarImageCacheForTests();
  const dataUrl = 'data:image/png;base64,c2h1';

  try {
    await loadAvatarThroughNativeProxy(
      'https://images.example/taylor.png',
      async <T,>() => dataUrl as T,
    );
    const markup = renderToStaticMarkup(
      <IdentityAvatar
        kind="human"
        seed="acct_alex"
        name="Alex Morgan"
        imageUrl="https://images.example/taylor.png"
      />,
    );

    assert.match(markup, /data-avatar-state="ready"/);
    assert.match(markup, /src="data:image\/png;base64,c2h1"/);
    assert.doesNotMatch(markup, />SH</);
  } finally {
    installed.restore();
  }
});

test('a blocked native avatar settles on one neutral fallback', async () => {
  const installed = installNativeDom();
  clearRemoteAvatarImageCacheForTests();
  let calls = 0;

  try {
    await assert.rejects(loadAvatarThroughNativeProxy(
      'https://images.example/blocked.png',
      async <T,>() => {
        calls += 1;
        throw new Error('blocked');
      },
    ));
    const markup = renderToStaticMarkup(
      <IdentityAvatar
        kind="human"
        seed="acct_alex"
        name="Alex Morgan"
        imageUrl="https://images.example/blocked.png"
      />,
    );

    assert.match(markup, /data-avatar-state="failed"/);
    assert.match(markup, /bg-slate-200/);
    assert.doesNotMatch(markup, />AL</);
    assert.doesNotMatch(markup, /<img/);
    await assert.rejects(loadAvatarThroughNativeProxy(
      'https://images.example/blocked.png',
      async <T,>() => {
        calls += 1;
        return 'data:image/png;base64,dW5yZWFjaGFibGU=' as T;
      },
    ));
    assert.equal(calls, 1);
  } finally {
    installed.restore();
  }
});

test('duplicate mounted avatars share one request and update together', async () => {
  const installed = installNativeDom();
  clearRemoteAvatarImageCacheForTests();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let resolveImage: ((value: string) => void) | null = null;
  let calls = 0;
  const request = loadAvatarThroughNativeProxy(
    'https://images.example/shared.png',
    async <T,>() => new Promise<T>((resolve) => {
      calls += 1;
      resolveImage = (value) => resolve(value as T);
    }),
  );

  try {
    await act(async () => {
      root?.render(
        <>
          <IdentityAvatar kind="human" seed="one" name="One" imageUrl="https://images.example/shared.png" />
          <IdentityAvatar kind="human" seed="two" name="Two" imageUrl="https://images.example/shared.png" />
        </>,
      );
    });
    assert.equal(host.querySelectorAll('[data-avatar-state="pending"]').length, 2);
    assert.equal(calls, 1);

    await act(async () => {
      resolveImage?.('data:image/png;base64,c2hhcmVk');
      await request;
    });
    assert.equal(host.querySelectorAll('[data-avatar-state="ready"]').length, 2);
    assert.equal(host.querySelectorAll('img[src="data:image/png;base64,c2hhcmVk"]').length, 2);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('an avatar keeps its last valid image while a replacement loads', async () => {
  const installed = installNativeDom();
  clearRemoteAvatarImageCacheForTests();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let resolveReplacement: ((value: string) => void) | null = null;
  const previousUrl = 'https://images.example/alex-v1.png';
  const replacementUrl = 'https://images.example/alex-v2.png';

  try {
    await loadAvatarThroughNativeProxy(
      previousUrl,
      async <T,>() => 'data:image/png;base64,b2xk' as T,
    );
    await act(async () => {
      root?.render(
        <IdentityAvatar kind="human" seed="acct_alex" name="Alex" imageUrl={previousUrl} />,
      );
    });
    await act(async () => {
      host.querySelector('img')?.dispatchEvent(new window.Event('load'));
    });
    const replacement = loadAvatarThroughNativeProxy(
      replacementUrl,
      async <T,>() => new Promise<T>((resolve) => {
        resolveReplacement = (value) => resolve(value as T);
      }),
    );
    await act(async () => {
      root?.render(
        <IdentityAvatar kind="human" seed="acct_alex" name="Alex" imageUrl={replacementUrl} />,
      );
    });
    assert.match(host.innerHTML, /data-avatar-state="stale"/);
    assert.match(host.innerHTML, /src="data:image\/png;base64,b2xk"/);

    await act(async () => {
      resolveReplacement?.('data:image/png;base64,bmV3');
      await replacement;
    });
    assert.match(host.innerHTML, /data-avatar-state="ready"/);
    assert.match(host.innerHTML, /src="data:image\/png;base64,bmV3"/);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});
