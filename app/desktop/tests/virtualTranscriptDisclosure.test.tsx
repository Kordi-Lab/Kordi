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
    getBoundingClientRect: {
      configurable: true,
      value(this: HTMLElement) {
        const isViewport = this.hasAttribute('data-virtual-transcript-scroll');
        const top = Number.parseFloat(this.dataset.testControlTop ?? '') || 0;
        const height = isViewport
          ? this.clientHeight
          : (Number.parseFloat(this.dataset.testControlHeight ?? '') || this.offsetHeight);
        const width = this.offsetWidth;
        return {
          x: 0,
          y: top,
          top,
          right: width,
          bottom: top + height,
          left: 0,
          width,
          height,
          toJSON: () => ({}),
        } as DOMRect;
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

async function renderMeasuredDisclosure(
  controlTop: number,
  options: { expandedHeight?: number; bodyHeight?: number } = {},
) {
  const expandedHeight = options.expandedHeight ?? 250;
  const bodyHeight = options.bodyHeight ?? 0;
  const items: Row[] = Array.from({ length: 20 }, (_, index) => ({ id: `disclosure-${index}`, height: 50 }));
  function DisclosureTranscript() {
    const [expanded, setExpanded] = React.useState(false);
    return (
      <VirtualTranscript
        items={items}
        sessionKey="stable-disclosure"
        getItemKey={(item) => item.id}
        renderItem={(item, index) => (
          <div
            data-message-id={item.id}
            data-test-row-height={index === items.length - 1 && expanded ? expandedHeight : item.height}
            data-transcript-stable-disclosure-root={index === items.length - 1 ? 'true' : undefined}
          >
            {index === items.length - 1 ? (
              <>
                <button
                  type="button"
                  data-test-control-top={controlTop}
                  data-test-control-height="20"
                  data-transcript-stable-disclosure="true"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((current) => !current)}
                >
                  Activity
                </button>
                {expanded ? (
                  <div
                    data-expanded-detail="true"
                    data-transcript-stable-disclosure-body="true"
                    style={bodyHeight > 0 ? { height: bodyHeight } : undefined}
                  >
                    Details
                  </div>
                ) : null}
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
  const disclosureRoot = button?.closest<HTMLElement>('[data-transcript-stable-disclosure-root]');
  assert.ok(viewport);
  assert.ok(button);
  assert.ok(measuredRow);
  assert.ok(disclosureRoot);
  return { host, viewport, button, measuredRow, disclosureRoot };
}

async function notifyDisclosureResize(disclosureRoot: HTMLElement, measuredRow: HTMLElement) {
  await act(async () => {
    assert.ok((triggerObservedResize?.(disclosureRoot) ?? 0) > 0);
    assert.ok((triggerObservedResize?.(measuredRow) ?? 0) > 0);
  });
  await flush();
}

test('a disclosure with enough room below expands downward without moving its control', async () => {
  const {
    host,
    viewport,
    button,
    measuredRow,
    disclosureRoot,
  } = await renderMeasuredDisclosure(100);
  const initialScrollTop = viewport.scrollTop;
  let resizeScrollEvents = 0;
  const countResizeScroll = () => { resizeScrollEvents += 1; };
  viewport.addEventListener('scroll', countResizeScroll);

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(button, host.querySelector('[data-transcript-stable-disclosure]'));
  assert.equal(measuredRow, button.closest('[data-transcript-window-item]'));
  await notifyDisclosureResize(disclosureRoot, measuredRow);

  assert.equal(button.nextElementSibling?.getAttribute('data-expanded-detail'), 'true');
  assert.equal(viewport.scrollTop, initialScrollTop);
  assert.equal(disclosureRoot.dataset.transcriptDisclosureDirection, 'down');
  assert.equal(resizeScrollEvents, 0, 'the disclosure must not first jump to the new tail and then correct itself');

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await notifyDisclosureResize(disclosureRoot, measuredRow);

  assert.equal(viewport.scrollTop, initialScrollTop);
  assert.equal(button.nextElementSibling, null);
  assert.equal(resizeScrollEvents, 0, 'repeated collapse must preserve the same stable control');
  viewport.removeEventListener('scroll', countResizeScroll);
});

test('a disclosure near the viewport bottom expands upward in the same measured frame', async () => {
  const {
    viewport,
    button,
    measuredRow,
    disclosureRoot,
  } = await renderMeasuredDisclosure(560);
  const initialScrollTop = viewport.scrollTop;

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await notifyDisclosureResize(disclosureRoot, measuredRow);

  assert.equal(disclosureRoot.dataset.transcriptDisclosureDirection, 'up');
  assert.equal(viewport.scrollTop, initialScrollTop + 200);
  assert.equal(button.nextElementSibling?.getAttribute('data-expanded-detail'), 'true');

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await notifyDisclosureResize(disclosureRoot, measuredRow);

  assert.equal(viewport.scrollTop, initialScrollTop, 'collapse should apply the inverse anchor compensation');
  assert.equal(button.nextElementSibling, null);
});

test('an oversized disclosure uses the larger side and constrains its body to the transcript viewport', async () => {
  const {
    button,
    measuredRow,
    disclosureRoot,
  } = await renderMeasuredDisclosure(300, { expandedHeight: 900, bodyHeight: 850 });

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await notifyDisclosureResize(disclosureRoot, measuredRow);

  const body = disclosureRoot.querySelector<HTMLElement>('[data-transcript-stable-disclosure-body]');
  assert.ok(body);
  assert.equal(disclosureRoot.dataset.transcriptDisclosureDirection, 'up');
  assert.equal(body.dataset.transcriptDisclosureConstrained, 'true');
  assert.equal(body.style.getPropertyValue('--app-transcript-disclosure-max-height'), '288px');
});

test('a live-tail disclosure uses the same upward expansion policy without a virtual row', async () => {
  const items: Row[] = Array.from({ length: 20 }, (_, index) => ({ id: `tail-${index}`, height: 50 }));
  function LiveTailDisclosureTranscript() {
    const [expanded, setExpanded] = React.useState(false);
    return (
      <VirtualTranscript
        items={items}
        sessionKey="live-tail-disclosure"
        getItemKey={(item) => item.id}
        renderItem={(item) => <div data-test-row-height={item.height}>{item.id}</div>}
        scrollStyle={{ height: 600 }}
        tail={(
          <div
            data-transcript-message-root="true"
            data-transcript-stable-disclosure-root="true"
            data-test-row-height={expanded ? 250 : 50}
          >
            <button
              type="button"
              data-test-control-top="560"
              data-test-control-height="20"
              data-transcript-stable-disclosure="true"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              Live activity
            </button>
            {expanded ? <div data-transcript-stable-disclosure-body="true">Details</div> : null}
          </div>
        )}
      />
    );
  }

  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<LiveTailDisclosureTranscript />));
  await flush();
  const viewport = host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  const button = host.querySelector<HTMLButtonElement>('[data-transcript-stable-disclosure]');
  const disclosureRoot = button?.closest<HTMLElement>('[data-transcript-stable-disclosure-root]');
  assert.ok(viewport);
  assert.ok(button);
  assert.ok(disclosureRoot);
  const initialScrollTop = viewport.scrollTop;

  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await act(async () => { assert.ok((triggerObservedResize?.(disclosureRoot) ?? 0) > 0); });
  await flush();

  assert.equal(disclosureRoot.dataset.transcriptDisclosureDirection, 'up');
  assert.equal(viewport.scrollTop, initialScrollTop + 200);
});
