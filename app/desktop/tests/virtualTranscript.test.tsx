import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import {
  cleanupVirtualTranscriptHarness,
  flush,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
  triggerObservedResize,
  virtualRowStart,
} from './support/virtualTranscriptHarness';

test.before(async () => {
  await installVirtualTranscriptHarness();
});

test.afterEach(async () => {
  await cleanupVirtualTranscriptHarness();
});

test('equal-length session switches mount the new tail before paint', async () => {
  const view = await render(transcript({ items: rows('a', 0, 1_000), sessionKey: 'a' }));

  await view.rerender(transcript({ items: rows('b', 0, 1_000), sessionKey: 'b' }));

  const mountedIds = [...view.host.querySelectorAll<HTMLElement>('[data-message-id]')]
    .map((node) => node.dataset.messageId);
  assert.ok(mountedIds.length > 0);
  assert.ok(mountedIds.every((id) => id?.startsWith('b')));
  assert.ok(mountedIds.includes('b999'));
});

test('session switches do not reuse message elements or measurements with matching item keys', async () => {
  const firstSession = rows('shared-', 0, 8, 36);
  const view = await render(transcript({ items: firstSession, sessionKey: 'session:a' }));
  const previousTail = view.host.querySelector<HTMLElement>('[data-message-id="shared-7"]');
  assert.ok(previousTail);

  await view.rerender(transcript({
    items: rows('shared-', 0, 8, 112),
    sessionKey: 'session:b',
  }));

  const nextTail = view.host.querySelector<HTMLElement>('[data-message-id="shared-7"]');
  assert.ok(nextTail);
  assert.notEqual(nextTail, previousTail);
  assert.equal(nextTail.dataset.testRowHeight, '112');
});

test('measured row positions update before the next React render', async () => {
  const view = await render(transcript({
    items: rows('measured-', 0, 8, 50),
    sessionKey: 'measured-session',
  }));
  const firstMessage = view.host.querySelector<HTMLElement>('[data-message-id="measured-0"]');
  const firstRow = firstMessage?.closest<HTMLElement>('[data-transcript-window-item]');
  const secondRow = view.host.querySelector<HTMLElement>('[data-message-id="measured-1"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(firstMessage);
  assert.ok(firstRow);
  assert.ok(secondRow);

  await act(async () => {
    firstMessage.dataset.testRowHeight = '180';
    assert.ok((triggerObservedResize?.(firstRow) ?? 0) > 0);
    assert.equal(virtualRowStart(secondRow), 184);
  });
});

test('a cold session aligns its tail when the first transcript page replaces loading copy', async () => {
  const view = await render(transcript({ items: [{ id: 'loading', height: 40 }], sessionKey: 'cold' }));

  await view.rerender(transcript({ items: rows('ready-', 0, 100), sessionKey: 'cold' }));

  assert.ok(view.host.querySelector('[data-message-id="ready-99"]'));
});

test('a two-row catalog preview hydrates into the chronological transcript tail', async () => {
  const view = await render(transcript({
    items: rows('ready-', 98, 2),
    sessionKey: 'catalog-preview',
  }));

  await view.rerender(transcript({
    items: rows('ready-', 0, 100),
    sessionKey: 'catalog-preview',
  }));

  assert.ok(view.host.querySelector('[data-message-id="ready-99"]'));
  const mountedRows = [...view.host.querySelectorAll<HTMLElement>('[data-transcript-window-item]')]
    .map((node) => ({
      id: node.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '',
      start: virtualRowStart(node),
    }))
    .sort((left, right) => left.start - right.start);
  assert.ok(mountedRows.length > 0);
  assert.deepEqual(
    mountedRows.map((row) => row.id),
    [...mountedRows].map((row) => row.id).sort((left, right) => (
      Number(left.slice('ready-'.length)) - Number(right.slice('ready-'.length))
    )),
  );
});

test('appending the latest message while pinned to the tail keeps the full row visible', async () => {
  const initialItems = rows('message-', 0, 20, 50);
  const view = await render(transcript({ items: initialItems, sessionKey: 'tail-follow' }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await view.rerender(transcript({
    items: [...initialItems, { id: 'message-20', height: 140 }],
    sessionKey: 'tail-follow',
  }));

  const latestRow = view.host.querySelector<HTMLElement>('[data-message-id="message-20"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(latestRow, 'the appended latest row should be mounted');
  const latestStart = virtualRowStart(latestRow);
  assert.ok(
    latestStart + latestRow.offsetHeight <= viewport.scrollTop + viewport.clientHeight,
    `latest row ended at ${latestStart + latestRow.offsetHeight}px but the viewport ended at ${viewport.scrollTop + viewport.clientHeight}px`,
  );
  assert.ok(
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
    'the transcript should remain pinned to the bottom after an append',
  );
});

test('appending queued or live tail content keeps the complete tail visible', async () => {
  const initialItems = rows('tail-message-', 0, 20, 50);
  const view = await render(transcript({
    items: initialItems,
    sessionKey: 'dynamic-tail',
    tailKey: 'empty',
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await view.rerender(transcript({
    items: initialItems,
    sessionKey: 'dynamic-tail',
    tailHeight: 140,
    tailKey: 'queued-message',
  }));

  assert.ok(
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
    'a newly queued or live row should not remain clipped below the viewport',
  );
});

test('shrinking the transcript viewport keeps the complete tail visible', async () => {
  const view = await render(transcript({
    items: rows('resize-message-', 0, 20, 50),
    sessionKey: 'resized-viewport',
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);
  await flush();
  const previousScrollTop = viewport.scrollTop;

  await act(async () => {
    viewport.style.height = '480px';
    assert.ok((triggerObservedResize?.(viewport) ?? 0) > 0);
  });
  await flush();

  assert.ok(viewport.scrollTop > previousScrollTop);
  assert.ok(
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
    'a shorter viewport should preserve the transcript tail above the composer',
  );
});

test('a measurement scroll event cannot cancel the pending tail correction', async () => {
  const initialItems = rows('webkit-', 0, 20, 50);
  const view = await render(transcript({ items: initialItems, sessionKey: 'webkit-tail-follow' }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const scheduledFrames: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    scheduledFrames.push(callback);
    return 10_000 + scheduledFrames.length;
  };

  try {
    await view.rerender(transcript({
      items: [...initialItems, { id: 'webkit-20', height: 140 }],
      sessionKey: 'webkit-tail-follow',
    }));

    const sizer = view.host.querySelector<HTMLElement>('[data-virtual-transcript-size]');
    assert.ok(sizer);
    await act(async () => {
      sizer.style.height = `${Number.parseFloat(sizer.style.height) + 50}px`;
      viewport.dispatchEvent(new window.Event('scroll'));
    });

    await act(async () => {
      for (const callback of scheduledFrames.splice(0)) callback(Date.now());
    });
    await flush();

    assert.ok(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
      'the scheduled correction should win over the layout-induced scroll event',
    );
  } finally {
    window.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test('appending a message does not pull a reader away from older history', async () => {
  const initialItems = rows('history-', 0, 100, 50);
  const view = await render(transcript({ items: initialItems, sessionKey: 'history-reader' }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await act(async () => viewport.scrollTo({ top: 1_000 }));
  await flush();
  const previousScrollTop = viewport.scrollTop;

  await view.rerender(transcript({
    items: [...initialItems, { id: 'history-100', height: 140 }],
    sessionKey: 'history-reader',
  }));

  assert.equal(viewport.scrollTop, previousScrollTop);
});

test('a scrolled-up transcript counts appended messages and clears at latest', async () => {
  const initialItems = rows('unread-', 0, 100, 50);
  const tailChanges: boolean[] = [];
  const view = await render(transcript({
    items: initialItems,
    sessionKey: 'new-message-count',
    onTailChange: (isAtTail) => tailChanges.push(isAtTail),
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await act(async () => viewport.scrollTo({ top: 1_000 }));
  await flush();
  assert.ok(view.host.querySelector('[data-transcript-latest-button="true"]'));
  assert.equal(view.host.querySelector('[data-new-message-count]'), null);

  await view.rerender(transcript({
    items: [...rows('older-', 0, 20, 50), ...initialItems],
    sessionKey: 'new-message-count',
    onTailChange: (isAtTail) => tailChanges.push(isAtTail),
  }));
  assert.equal(view.host.querySelector('[data-new-message-count]'), null);

  await view.rerender(transcript({
    items: [...rows('older-', 0, 20, 50), ...initialItems, ...rows('new-', 0, 120, 50)],
    sessionKey: 'new-message-count',
    unreadCount: 120,
    onTailChange: (isAtTail) => tailChanges.push(isAtTail),
  }));
  const badge = view.host.querySelector<HTMLElement>('[data-new-message-count]');
  assert.equal(badge?.dataset.newMessageCount, '120');
  assert.equal(badge?.textContent, '99+');

  const button = view.host.querySelector<HTMLButtonElement>('[data-transcript-latest-button="true"]');
  assert.match(button?.getAttribute('aria-label') ?? '', /120 new messages/);
  tailChanges.length = 0;
  await act(async () => button?.click());
  await flush();
  assert.equal(view.host.querySelector('[data-transcript-latest-button="true"]'), null);
  assert.equal(tailChanges.at(-1), true);
});

test('a 900px row is measured before following short rows are positioned', async () => {
  const items = [{ id: 'tall', height: 900 }, ...rows('short-', 0, 30, 40)];
  const view = await render(transcript({ items }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await act(async () => viewport.scrollTo({ top: 0 }));
  await flush();

  const shortRow = view.host.querySelector<HTMLElement>('[data-message-id^="short-"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(shortRow);
  const start = virtualRowStart(shortRow);
  assert.ok(start >= 900, `short row started at ${start}px`);
  assert.equal(view.host.querySelector('[data-transcript-window-spacer]'), null);
});

test('prepending an older page preserves the first visible message and pixel offset', async () => {
  const initial = rows('m', 100, 100);
  const view = await render(transcript({ items: initial }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);
  await act(async () => viewport.scrollTo({ top: 1_100 }));
  await flush();

  const before = [...view.host.querySelectorAll<HTMLElement>('[data-transcript-window-item]')]
    .find((node) => {
      const start = virtualRowStart(node);
      return start <= viewport.scrollTop && start + node.offsetHeight > viewport.scrollTop;
    });
  assert.ok(before);
  const anchorId = before.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId;
  const beforeStart = virtualRowStart(before);
  const beforeOffset = beforeStart - viewport.scrollTop;

  await view.rerender(transcript({ items: [...rows('m', 0, 100), ...initial] }));

  const after = view.host.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`)?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(after, `expected ${anchorId} to remain mounted at scrollTop ${viewport.scrollTop}; mounted ${[
    ...view.host.querySelectorAll<HTMLElement>('[data-message-id]'),
  ].map((node) => node.dataset.messageId).join(',')}`);
  const afterStart = virtualRowStart(after);
  assert.ok(Math.abs((afterStart - viewport.scrollTop) - beforeOffset) < 1);
});

test('jump-to-message loads older pages until the target exists and then mounts it', async () => {
  const loadCalls: string[] = [];
  const readyIds: string[] = [];
  function Harness() {
    const [items, setItems] = React.useState(() => rows('m', 900, 100));
    const [hasOlder, setHasOlder] = React.useState(true);
    return transcript({
      items,
      navigationRequest: { id: 'm850', nonce: 1 },
      onNavigationReady: (id) => readyIds.push(id),
      hasOlder,
      onLoadOlder: async () => {
        loadCalls.push('older');
        setItems((current) => [...rows('m', 850, 50), ...current]);
        setHasOlder(false);
      },
    });
  }

  const view = await render(<Harness />);
  await flush();
  await view.rerender(<Harness />);

  assert.equal(loadCalls.length, 1);
  assert.deepEqual(readyIds, ['m850']);
  assert.ok(view.host.querySelector('[data-message-id="m850"]'));
  assert.equal(view.host.querySelector('[data-transcript-loading-older="true"]'), null);
});

test('a handled navigation request stays one-shot across transcript rerenders', async () => {
  const readyIds: string[] = [];
  const initialItems = rows('m', 0, 20);
  const request = { id: 'm10', nonce: 1 };
  const view = await render(transcript({
    items: initialItems,
    navigationRequest: request,
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['m10']);

  await view.rerender(transcript({
    items: [...initialItems],
    navigationRequest: { ...request },
    onNavigationReady: (id) => readyIds.push(id),
  }));
  await view.rerender(transcript({
    items: [...initialItems, { id: 'm20', height: 75 }],
    navigationRequest: { ...request },
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['m10']);
});

test('a new navigation nonce handles the same message exactly one more time', async () => {
  const readyIds: string[] = [];
  const items = rows('m', 0, 20);
  const view = await render(transcript({
    items,
    navigationRequest: { id: 'm10', nonce: 1 },
    onNavigationReady: (id) => readyIds.push(id),
  }));

  await view.rerender(transcript({
    items: [...items],
    navigationRequest: { id: 'm10', nonce: 2 },
    onNavigationReady: (id) => readyIds.push(id),
  }));
  await view.rerender(transcript({
    items: [...items],
    navigationRequest: { id: 'm10', nonce: 2 },
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['m10', 'm10']);
});

test('main and companion transcript requests remain independently one-shot', async () => {
  const mainReady: string[] = [];
  const companionReady: string[] = [];
  const mainItems = rows('main-', 0, 20);
  const companionItems = rows('companion-', 0, 20);
  const pair = () => (
    <>
      {transcript({
        items: [...mainItems],
        sessionKey: 'main-session',
        navigationRequest: { id: 'main-10', nonce: 1 },
        onNavigationReady: (id) => mainReady.push(id),
      })}
      {transcript({
        items: [...companionItems],
        sessionKey: 'companion-session',
        navigationRequest: { id: 'companion-10', nonce: 2 },
        onNavigationReady: (id) => companionReady.push(id),
      })}
    </>
  );
  const view = await render(pair());

  await view.rerender(pair());

  assert.deepEqual(mainReady, ['main-10']);
  assert.deepEqual(companionReady, ['companion-10']);
});

test('a handled navigation request stays consumed after the transcript remounts', async () => {
  const readyIds: string[] = [];
  const request = { id: 'm10', nonce: 1, sessionKey: 'session:one' };
  function Harness({ visible }: { visible: boolean }) {
    const [navigationRequest, setNavigationRequest] = React.useState<typeof request | null>(request);
    if (!visible) return null;
    return transcript({
      items: rows('m', 0, 20),
      navigationRequest,
      onNavigationReady: (id) => readyIds.push(id),
      onNavigationHandled: (handled) => {
        setNavigationRequest((current) => (
          current
          && current.id === handled.id
          && current.nonce === handled.nonce
          && current.sessionKey === handled.sessionKey
            ? null
            : current
        ));
      },
    });
  }

  const view = await render(<Harness visible />);
  assert.deepEqual(readyIds, ['m10']);

  await view.rerender(<Harness visible={false} />);
  await flush();
  await view.rerender(<Harness visible />);
  await flush();

  assert.deepEqual(readyIds, ['m10']);
  assert.ok(view.host.querySelector('[data-message-id="m10"]'));
});

test('a navigation request cannot replay against a different session with a colliding target id', async () => {
  const readyIds: string[] = [];
  const request = { id: 'shared', nonce: 1, sessionKey: 'session:a' };
  const view = await render(transcript({
    items: [{ id: 'shared', height: 50 }],
    sessionKey: 'session:a',
    navigationRequest: request,
    onNavigationReady: (id) => readyIds.push(id),
  }));

  await view.rerender(transcript({
    items: [{ id: 'shared', height: 50 }],
    sessionKey: 'session:b',
    navigationRequest: request,
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['shared']);
});

test('a navigation request cannot load older pages for a different session', async () => {
  let loadCount = 0;
  const readyIds: string[] = [];
  const request = { id: 'shared', nonce: 1, sessionKey: 'session:a' };
  const view = await render(transcript({
    items: rows('b-', 0, 20),
    sessionKey: 'session:b',
    hasOlder: true,
    onLoadOlder: () => { loadCount += 1; },
  }));
  const baselineLoadCount = loadCount;

  await view.rerender(transcript({
    items: rows('b-', 0, 20),
    sessionKey: 'session:b',
    navigationRequest: request,
    onNavigationReady: (id) => readyIds.push(id),
    hasOlder: true,
    onLoadOlder: () => { loadCount += 1; },
  }));

  assert.equal(loadCount, baselineLoadCount);
  assert.deepEqual(readyIds, []);

  await view.rerender(transcript({
    items: [{ id: 'shared', height: 50 }],
    sessionKey: 'session:a',
    navigationRequest: request,
    onNavigationReady: (id) => readyIds.push(id),
    hasOlder: false,
  }));

  assert.deepEqual(readyIds, ['shared']);
});

test('a 1,000-message transcript mounts at most 60 row nodes', async () => {
  const view = await render(transcript({ items: rows('m', 0, 1_000) }));
  const mounted = view.host.querySelectorAll('[data-transcript-window-item]');

  assert.ok(mounted.length > 0);
  assert.ok(mounted.length <= 60, `mounted ${mounted.length} transcript rows`);
});

test('ready rows remain visible while older-page loading stays non-visual', async () => {
  let resolveLoad: (() => void) | null = null;
  const loading = new Promise<void>((resolve) => { resolveLoad = resolve; });
  const view = await render(transcript({
    items: rows('m', 900, 100),
    navigationRequest: { id: 'm100', nonce: 1 },
    hasOlder: true,
    onLoadOlder: () => loading,
  }));

  assert.ok(view.host.querySelectorAll('[data-transcript-window-item]').length > 0);
  assert.ok(view.host.querySelector('[data-transcript-loading-older="true"]'));
  assert.equal(view.host.querySelector('[data-transcript-older-loading="true"]'), null);
  assert.doesNotMatch(view.host.textContent ?? '', /Loading (earlier|previous) messages/i);
  await act(async () => resolveLoad?.());
});

test('disabling canonical paging clears an in-flight earlier-message loader', async () => {
  let resolveLoad: (() => void) | null = null;
  const loading = new Promise<void>((resolve) => { resolveLoad = resolve; });
  const items = rows('runtime-', 0, 8);
  const view = await render(transcript({
    items,
    sessionKey: 'runtime-session',
    navigationRequest: { id: 'older-message', nonce: 1 },
    hasOlder: true,
    onLoadOlder: () => loading,
  }));

  assert.ok(view.host.querySelector('[data-transcript-loading-older="true"]'));

  await view.rerender(transcript({
    items,
    sessionKey: 'runtime-session',
    hasOlder: false,
  }));

  const loaderStayedVisible = Boolean(view.host.querySelector('[data-transcript-loading-older="true"]'));
  await act(async () => resolveLoad?.());
  assert.equal(loaderStayedVisible, false);
});

test('switching sessions clears an earlier-message loader owned by the previous session', async () => {
  let resolveLoad: (() => void) | null = null;
  const loading = new Promise<void>((resolve) => { resolveLoad = resolve; });
  const view = await render(transcript({
    items: rows('old-', 0, 8),
    sessionKey: 'old-session',
    navigationRequest: { id: 'older-message', nonce: 1 },
    hasOlder: true,
    onLoadOlder: () => loading,
  }));

  assert.ok(view.host.querySelector('[data-transcript-loading-older="true"]'));

  await view.rerender(transcript({
    items: rows('new-', 0, 8),
    sessionKey: 'new-session',
    hasOlder: false,
  }));

  const loaderFollowedSessionSwitch = Boolean(view.host.querySelector('[data-transcript-loading-older="true"]'));
  await act(async () => resolveLoad?.());
  assert.equal(loaderFollowedSessionSwitch, false);
  assert.equal(view.host.querySelector('[data-transcript-loading-older="true"]'), null);
});

test('a transcript with canonical paging disabled never shows the earlier-message loader', async () => {
  let loadCount = 0;
  const view = await render(transcript({
    items: rows('m', 0, 8),
    hasOlder: false,
    onLoadOlder: () => { loadCount += 1; },
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await act(async () => viewport.scrollTo({ top: 0 }));
  await flush();

  assert.equal(loadCount, 0);
  assert.equal(view.host.querySelector('[data-transcript-loading-older="true"]'), null);
});

test('strict mode clears the earlier-message loader after the request finishes', async () => {
  const view = await render(
    <React.StrictMode>
      {transcript({
        items: rows('strict-', 0, 8),
        sessionKey: 'strict-session',
        navigationRequest: { id: 'older-message', nonce: 1 },
        hasOlder: true,
        onLoadOlder: async () => undefined,
      })}
    </React.StrictMode>,
  );
  await flush();

  assert.equal(view.host.querySelector('[data-transcript-loading-older="true"]'), null);
});
