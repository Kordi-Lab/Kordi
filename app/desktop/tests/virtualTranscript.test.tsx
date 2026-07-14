import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Row = { id: string; height: number };

let VirtualTranscript: typeof import('../src/features/chat/VirtualTranscript').VirtualTranscript;
let root: Root | null = null;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  target.HTMLElement = dom.window.HTMLElement;
  target.Element = dom.window.Element;
  target.Node = dom.window.Node;
  target.Event = dom.window.Event;
  target.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  target.IS_REACT_ACT_ENVIRONMENT = true;
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    dom.window.setTimeout(() => callback(Date.now()), 0)
  );
  const cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  target.requestAnimationFrame = requestAnimationFrame;
  target.cancelAnimationFrame = cancelAnimationFrame;
  dom.window.requestAnimationFrame = requestAnimationFrame;
  dom.window.cancelAnimationFrame = cancelAnimationFrame;

  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 0;
      },
    },
    clientWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        const measuredChild = this.querySelector<HTMLElement>('[data-test-row-height]');
        return Number.parseFloat(measuredChild?.dataset.testRowHeight ?? '')
          || Number.parseFloat(this.style.height)
          || 0;
      },
    },
    offsetWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        const container = this.querySelector<HTMLElement>('[data-virtual-transcript-size]');
        return Number.parseFloat(container?.style.height ?? '') || this.clientHeight;
      },
    },
  });

  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number) {
    const top = typeof options === 'number'
      ? (typeof y === 'number' ? y : options)
      : Number(options?.top ?? this.scrollTop);
    this.scrollTop = Math.max(0, top);
    this.dispatchEvent(new dom.window.Event('scroll'));
  };

  class DeterministicResizeObserver {
    readonly callback: ResizeObserverCallback;
    readonly observed = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(element: Element) {
      this.observed.add(element);
      const targetElement = element as HTMLElement;
      queueMicrotask(() => {
        if (!this.observed.has(element) || !element.isConnected) return;
        this.callback([{
          target: element,
          borderBoxSize: [{
            blockSize: targetElement.offsetHeight,
            inlineSize: targetElement.offsetWidth,
          }],
        } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      });
    }

    unobserve(element: Element) {
      this.observed.delete(element);
    }

    disconnect() {
      this.observed.clear();
    }
  }

  target.ResizeObserver = DeterministicResizeObserver;
  (dom.window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = DeterministicResizeObserver as unknown as typeof ResizeObserver;
}

function rows(prefix: string, start: number, count: number, height = 50): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${start + index}`,
    height,
  }));
}

function transcript(props: {
  items: readonly Row[];
  sessionKey?: string;
  navigationRequest?: { id: string; nonce: number } | null;
  onNavigationReady?: (messageId: string) => void;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<void> | void;
}) {
  return (
    <VirtualTranscript
      items={props.items}
      sessionKey={props.sessionKey ?? 'session:one'}
      getItemKey={(item) => item.id}
      renderItem={(item) => (
        <div data-message-id={item.id} data-test-row-height={item.height}>{item.id}</div>
      )}
      scrollStyle={{ height: 600 }}
      navigationRequest={props.navigationRequest}
      findNavigationIndex={(item, id) => item.id === id}
      onNavigationReady={props.onNavigationReady}
      hasOlder={props.hasOlder}
      onLoadOlder={props.onLoadOlder}
    />
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(element: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  await flush();
  return {
    host,
    rerender: async (next: React.ReactNode) => {
      await act(async () => root?.render(next));
      await flush();
    },
  };
}

test.before(async () => {
  installDom();
  ({ VirtualTranscript } = await import('../src/features/chat/VirtualTranscript'));
});

test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
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

test('a cold session aligns its tail when the first transcript page replaces loading copy', async () => {
  const view = await render(transcript({ items: [{ id: 'loading', height: 40 }], sessionKey: 'cold' }));

  await view.rerender(transcript({ items: rows('ready-', 0, 100), sessionKey: 'cold' }));

  assert.ok(view.host.querySelector('[data-message-id="ready-99"]'));
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
  const start = Number.parseFloat(shortRow.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? '0');
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
      const start = Number.parseFloat(node.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? '0');
      return start <= viewport.scrollTop && start + node.offsetHeight > viewport.scrollTop;
    });
  assert.ok(before);
  const anchorId = before.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId;
  const beforeStart = Number.parseFloat(before.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? '0');
  const beforeOffset = beforeStart - viewport.scrollTop;

  await view.rerender(transcript({ items: [...rows('m', 0, 100), ...initial] }));

  const after = view.host.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`)?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(after, `expected ${anchorId} to remain mounted at scrollTop ${viewport.scrollTop}; mounted ${[
    ...view.host.querySelectorAll<HTMLElement>('[data-message-id]'),
  ].map((node) => node.dataset.messageId).join(',')}`);
  const afterStart = Number.parseFloat(after.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? '0');
  assert.ok(Math.abs((afterStart - viewport.scrollTop) - beforeOffset) < 1);
});

test('jump-to-message loads older pages until the target exists and then mounts it', async () => {
  let loadCount = 0;
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
        loadCount += 1;
        setItems((current) => [...rows('m', 850, 50), ...current]);
        setHasOlder(false);
      },
    });
  }

  const view = await render(<Harness />);
  await flush();
  await view.rerender(<Harness />);

  assert.equal(loadCount, 1);
  assert.deepEqual(readyIds, ['m850']);
  assert.ok(view.host.querySelector('[data-message-id="m850"]'));
  assert.equal(view.host.querySelector('[data-transcript-older-loading="true"]'), null);
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

test('a 1,000-message transcript mounts at most 60 row nodes', async () => {
  const view = await render(transcript({ items: rows('m', 0, 1_000) }));
  const mounted = view.host.querySelectorAll('[data-transcript-window-item]');

  assert.ok(mounted.length > 0);
  assert.ok(mounted.length <= 60, `mounted ${mounted.length} transcript rows`);
});

test('ready rows remain visible while an older page is loading', async () => {
  let resolveLoad: (() => void) | null = null;
  const loading = new Promise<void>((resolve) => { resolveLoad = resolve; });
  const view = await render(transcript({
    items: rows('m', 900, 100),
    navigationRequest: { id: 'm100', nonce: 1 },
    hasOlder: true,
    onLoadOlder: () => loading,
  }));

  assert.ok(view.host.querySelectorAll('[data-transcript-window-item]').length > 0);
  assert.ok(view.host.querySelector('[data-transcript-older-loading="true"]'));
  await act(async () => resolveLoad?.());
});
