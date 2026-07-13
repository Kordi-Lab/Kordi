import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ChatSidebarRow } from '../src/pages/sidebar/VirtualChatList';

let VirtualChatList: typeof import('../src/pages/sidebar/VirtualChatList').VirtualChatList;
let buildChatSidebarRows: typeof import('../src/pages/sidebar/VirtualChatList').buildChatSidebarRows;
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
  target.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
  target.cancelAnimationFrame = (id: number) => clearTimeout(id);

  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 0;
      },
    },
    clientWidth: { configurable: true, get: () => 320 },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.dataset.testRowHeight ?? '')
          || Number.parseFloat(this.style.height)
          || 48;
      },
    },
    offsetWidth: { configurable: true, get: () => 320 },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        const size = this.querySelector<HTMLElement>('[data-virtual-chat-list-size]');
        return Number.parseFloat(size?.style.height ?? '') || this.clientHeight;
      },
    },
  });

  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === 'number'
      ? (typeof y === 'number' ? y : options)
      : Number(options?.top ?? this.scrollTop);
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
      queueMicrotask(() => {
        if (!this.observed.has(element) || !element.isConnected) return;
        const measured = element as HTMLElement;
        this.callback([{
          target: element,
          borderBoxSize: [{ blockSize: measured.offsetHeight, inlineSize: measured.offsetWidth }],
        } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      });
    }

    unobserve(element: Element) { this.observed.delete(element); }

    disconnect() { this.observed.clear(); }
  }

  target.ResizeObserver = DeterministicResizeObserver;
  (dom.window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = DeterministicResizeObserver as unknown as typeof ResizeObserver;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test.before(async () => {
  installDom();
  ({ VirtualChatList, buildChatSidebarRows } = await import('../src/pages/sidebar/VirtualChatList'));
});

test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

test('flat descriptors own expansion, active ancestry, and fork traversal', () => {
  const sessions = [
    { sessionId: 'root', spaceId: 'space:one', parentSessionId: null },
    { sessionId: 'child-active', spaceId: 'space:one', parentSessionId: 'root' },
    { sessionId: 'grand-active', spaceId: 'space:one', parentSessionId: 'child-active' },
    { sessionId: 'child-hidden', spaceId: 'space:one', parentSessionId: 'root' },
  ];
  const collapsed = buildChatSidebarRows({
    spaces: [{ spaceId: 'space:one', expanded: true, rootSessionIds: ['root'] }],
    sessions,
    collapsedForkParentIds: new Set(['root']),
    activeSessionId: 'grand-active',
    includeSpaceRows: true,
  });

  assert.deepEqual(collapsed.map((row) => row.key), [
    'space:space:one',
    'session:root',
    'session:child-active',
    'session:grand-active',
  ]);
  assert.deepEqual(collapsed.map((row) => row.depth), [0, 0, 1, 2]);
  assert.deepEqual(
    collapsed
      .filter((row) => row.kind === 'session' && row.activePath)
      .map((row) => row.sessionId),
    ['root', 'child-active', 'grand-active'],
  );

  const expanded = buildChatSidebarRows({
    spaces: [{ spaceId: 'space:one', expanded: true, rootSessionIds: ['root'] }],
    sessions,
    collapsedForkParentIds: new Set(),
    activeSessionId: 'grand-active',
    includeSpaceRows: true,
  });
  assert.equal(expanded.length, collapsed.length + 1);
  assert.ok(expanded.some((row) => row.key === 'session:child-hidden'));
});

test('two sessions in one group space switch the active child row by exact id', async () => {
  const selectedIds: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  function GroupSessionHarness() {
    const [activeSessionId, setActiveSessionId] = useState('session:group:new');
    const rows = useMemo(() => buildChatSidebarRows({
      spaces: [{
        spaceId: 'group:session:group:shared',
        expanded: true,
        rootSessionIds: ['session:group:new', 'session:group:old'],
      }],
      sessions: [
        { sessionId: 'session:group:new', spaceId: 'group:session:group:shared', parentSessionId: null },
        { sessionId: 'session:group:old', spaceId: 'group:session:group:shared', parentSessionId: null },
      ],
      collapsedForkParentIds: new Set<string>(),
      activeSessionId,
      includeSpaceRows: true,
    }), [activeSessionId]);

    return (
      <VirtualChatList
        rows={rows}
        activeSessionId={activeSessionId}
        scrollStyle={{ height: 240 }}
        renderRow={(row) => row.kind === 'session' ? (
          <button
            type="button"
            data-group-session-id={row.sessionId}
            data-test-row-height="48"
            className={row.sessionId === activeSessionId ? 'app-session-row-active' : ''}
            onClick={() => {
              selectedIds.push(row.sessionId);
              setActiveSessionId(row.sessionId);
            }}
          >
            {row.sessionId}
          </button>
        ) : <div data-test-row-height="48">Shared group</div>}
      />
    );
  }

  await act(async () => root?.render(<GroupSessionHarness />));
  await flush();
  const oldSession = host.querySelector<HTMLButtonElement>('[data-group-session-id="session:group:old"]');
  assert.ok(oldSession);
  assert.equal(host.querySelector('.app-session-row-active')?.getAttribute('data-group-session-id'), 'session:group:new');

  await act(async () => oldSession.click());
  await flush();

  assert.deepEqual(selectedIds, ['session:group:old']);
  assert.equal(host.querySelectorAll('.app-session-row-active').length, 1);
  assert.equal(host.querySelector('.app-session-row-active')?.getAttribute('data-group-session-id'), 'session:group:old');
});

test('500 sidebar descriptors mount at most 80 rows and scroll the active row into view', async () => {
  const rows: ChatSidebarRow[] = Array.from({ length: 500 }, (_, index) => ({
    kind: 'session',
    key: `session:s${index}`,
    sessionId: `s${index}`,
    spaceId: `space:${Math.floor(index / 10)}`,
    depth: index % 7 === 0 ? 1 : 0,
    activePath: index === 499,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  await act(async () => root?.render(
    <VirtualChatList
      rows={rows}
      activeSessionId="s499"
      scrollStyle={{ height: 500 }}
      renderRow={(row) => (
        <div data-sidebar-session-id={row.kind === 'session' ? row.sessionId : ''} data-test-row-height="48">
          {row.key}
        </div>
      )}
    />,
  ));
  await flush();

  const mounted = host.querySelectorAll('[data-chat-sidebar-row]');
  assert.ok(mounted.length > 0);
  assert.ok(mounted.length <= 80, `mounted ${mounted.length} sidebar rows`);
  assert.ok(host.querySelector('[data-sidebar-session-id="s499"]'));

  const allUnread = rows.reduce((total, _row, index) => total + Number(index % 10 === 0), 0);
  const mountedUnread = [...host.querySelectorAll('[data-chat-sidebar-row]')]
    .reduce((total, row) => total + Number(Number(row.getAttribute('data-index')) % 10 === 0), 0);
  assert.equal(allUnread, 50);
  assert.ok(mountedUnread < allUnread, 'offscreen rows must remain part of data totals without mounting');
});
