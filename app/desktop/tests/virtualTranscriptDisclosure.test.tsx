import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Row = { id: string; height: number };

let VirtualTranscript: typeof import('../src/features/chat/VirtualTranscript').VirtualTranscript;
let root: Root | null = null;
let triggerObservedResize: ((element: Element) => number) | null = null;

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
  const requestAnimationFrame = (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  target.requestAnimationFrame = requestAnimationFrame;
  target.cancelAnimationFrame = cancelAnimationFrame;
  dom.window.requestAnimationFrame = requestAnimationFrame;
  dom.window.cancelAnimationFrame = cancelAnimationFrame;

  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return Number.parseFloat(this.style.height) || 0; } },
    clientWidth: { configurable: true, get() { return 800; } },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        const measuredChild = this.querySelector<HTMLElement>('[data-test-row-height]');
        return Number.parseFloat(this.dataset.testRowHeight ?? '')
          || Number.parseFloat(this.style.height)
          || Number.parseFloat(measuredChild?.dataset.testRowHeight ?? '')
          || 0;
      },
    },
    offsetWidth: { configurable: true, get() { return 800; } },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        const container = this.querySelector<HTMLElement>('[data-virtual-transcript-size]');
        return Math.max(Number.parseFloat(container?.style.height ?? '') || 0, this.clientHeight);
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

  const observers = new Set<DeterministicResizeObserver>();
  class DeterministicResizeObserver {
    readonly callback: ResizeObserverCallback;
    readonly observed = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.add(this);
    }

    notify(element: Element) {
      if (!this.observed.has(element) || !element.isConnected) return;
      const measured = element as HTMLElement;
      this.callback([{
        target: element,
        borderBoxSize: [{ blockSize: measured.offsetHeight, inlineSize: measured.offsetWidth }],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    observe(element: Element) {
      this.observed.add(element);
      queueMicrotask(() => this.notify(element));
    }

    unobserve(element: Element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); observers.delete(this); }
  }

  triggerObservedResize = (element) => {
    let count = 0;
    for (const observer of observers) {
      if (!observer.observed.has(element)) continue;
      observer.notify(element);
      count += 1;
    }
    return count;
  };
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
  ({ VirtualTranscript } = await import('../src/features/chat/VirtualTranscript'));
});

test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

test('animating a measured disclosure downward keeps its control stable', async () => {
  const items: Row[] = Array.from({ length: 20 }, (_, index) => ({ id: `disclosure-${index}`, height: 50 }));
  function DisclosureTranscript() {
    const [expanded, setExpanded] = React.useState(false);
    return (
      <VirtualTranscript
        items={items}
        sessionKey="stable-disclosure"
        getItemKey={(item) => item.id}
        renderItem={(item, index) => (
          <div data-message-id={item.id} data-test-row-height={index === items.length - 1 && expanded ? 250 : item.height}>
            {index === items.length - 1 ? (
              <>
                <button type="button" data-transcript-stable-disclosure="true" onClick={() => setExpanded((current) => !current)}>
                  Activity
                </button>
                {expanded ? <div data-expanded-detail="true">Details</div> : null}
              </>
            ) : item.id}
          </div>
        )}
        scrollStyle={{ height: 600 }}
      />
    );
  }

  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<DisclosureTranscript />));
  await flush();
  const viewport = host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  const button = host.querySelector<HTMLButtonElement>('[data-transcript-stable-disclosure]');
  const measuredRow = button?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(viewport);
  assert.ok(button);
  assert.ok(measuredRow);
  const initialScrollTop = viewport.scrollTop;
  let resizeScrollEvents = 0;
  const countResizeScroll = () => { resizeScrollEvents += 1; };
  viewport.addEventListener('scroll', countResizeScroll);

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(button, host.querySelector('[data-transcript-stable-disclosure]'));
  assert.equal(measuredRow, button.closest('[data-transcript-window-item]'));
  await act(async () => { assert.ok((triggerObservedResize?.(measuredRow) ?? 0) > 0); });
  await flush();

  assert.equal(button.nextElementSibling?.getAttribute('data-expanded-detail'), 'true');
  assert.equal(viewport.scrollTop, initialScrollTop);
  assert.equal(resizeScrollEvents, 0, 'the disclosure must not first jump to the new tail and then correct itself');

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await act(async () => { assert.ok((triggerObservedResize?.(measuredRow) ?? 0) > 0); });
  await flush();

  assert.equal(viewport.scrollTop, initialScrollTop);
  assert.equal(button.nextElementSibling, null);
  assert.equal(resizeScrollEvents, 0, 'repeated collapse must preserve the same stable control');
  viewport.removeEventListener('scroll', countResizeScroll);
});
