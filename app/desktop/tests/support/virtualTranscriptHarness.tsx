import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Row = { id: string; height: number };

let VirtualTranscript: typeof import('../../src/features/chat/VirtualTranscript').VirtualTranscript;
let root: Root | null = null;
export let triggerObservedResize: ((element: Element) => number) | null = null;

export async function installVirtualTranscriptHarness() {
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
        return Number.parseFloat(this.dataset.testRowHeight ?? '')
          || Number.parseFloat(this.style.height)
          || Number.parseFloat(measuredChild?.dataset.testRowHeight ?? '')
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
        const tail = this.querySelector<HTMLElement>('[data-test-transcript-tail]');
        const contentHeight = (Number.parseFloat(container?.style.height ?? '') || 0)
          + (tail?.offsetHeight ?? 0);
        return Math.max(contentHeight, this.clientHeight);
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
      resizeObservers.add(this);
    }

    notify(element: Element) {
      if (!this.observed.has(element) || !element.isConnected) return;
      const targetElement = element as HTMLElement;
      this.callback([{
        target: element,
        borderBoxSize: [{
          blockSize: targetElement.offsetHeight,
          inlineSize: targetElement.offsetWidth,
        }],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }

    observe(element: Element) {
      this.observed.add(element);
      queueMicrotask(() => this.notify(element));
    }

    unobserve(element: Element) {
      this.observed.delete(element);
    }

    disconnect() {
      this.observed.clear();
      resizeObservers.delete(this);
    }
  }

  const resizeObservers = new Set<DeterministicResizeObserver>();
  triggerObservedResize = (element) => {
    let notified = 0;
    for (const observer of resizeObservers) {
      if (!observer.observed.has(element)) continue;
      observer.notify(element);
      notified += 1;
    }
    return notified;
  };

  target.ResizeObserver = DeterministicResizeObserver;
  (dom.window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = DeterministicResizeObserver as unknown as typeof ResizeObserver;
  ({ VirtualTranscript } = await import('../../src/features/chat/VirtualTranscript'));
}

export async function cleanupVirtualTranscriptHarness() {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

export function rows(prefix: string, start: number, count: number, height = 50): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${start + index}`, height }));
}

export function virtualRowStart(node: HTMLElement) {
  const transform = node.style.transform;
  return Number.parseFloat(
    transform.match(/translate(?:3d|Y)\([^,]*,?\s*([-\d.]+)px/)?.[1] ?? '0',
  );
}

export function transcript(props: {
  items: readonly Row[];
  sessionKey?: string;
  navigationRequest?: { id: string; nonce: number; sessionKey?: string } | null;
  onNavigationReady?: (messageId: string) => void;
  onNavigationHandled?: (request: { id: string; nonce: number; sessionKey: string }) => void;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<void> | void;
  tailHeight?: number;
  tailKey?: string;
}) {
  const sessionKey = props.sessionKey ?? 'session:one';
  const navigationRequest = props.navigationRequest
    ? { ...props.navigationRequest, sessionKey: props.navigationRequest.sessionKey ?? sessionKey }
    : props.navigationRequest;
  return (
    <VirtualTranscript
      items={props.items}
      sessionKey={sessionKey}
      getItemKey={(item) => item.id}
      renderItem={(item) => (
        <div data-message-id={item.id} data-test-row-height={item.height}>{item.id}</div>
      )}
      scrollStyle={{ height: 600 }}
      navigationRequest={navigationRequest}
      findNavigationIndex={(item, id) => item.id === id}
      onNavigationReady={props.onNavigationReady}
      onNavigationHandled={props.onNavigationHandled}
      hasOlder={props.hasOlder}
      onLoadOlder={props.onLoadOlder}
      tailKey={props.tailKey}
      tail={props.tailHeight ? (
        <div data-test-transcript-tail data-test-row-height={props.tailHeight}>tail</div>
      ) : null}
    />
  );
}

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function render(element: React.ReactNode) {
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
