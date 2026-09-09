import { JSDOM } from 'jsdom';
import { act } from 'react';

export const sidebarTestDom = {
  clampScrollToContent: false,
  notifyMeasuredResize: () => {},
};

export function installDom() {
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
        if (this.dataset.participantSpaceBlock) {
          const clip = this.querySelector<HTMLElement>('.app-participant-channel-reveal');
          return 64 + Number.parseFloat(clip?.style.height || '0');
        }
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
    if (sidebarTestDom.clampScrollToContent) this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.scrollHeight - this.clientHeight));
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

  sidebarTestDom.notifyMeasuredResize = () => {
    for (const observer of observers) {
      for (const element of observer.observed) {
        if (!element.isConnected) continue;
        const measured = element as HTMLElement;
        observer.callback([{
          target: element,
          borderBoxSize: [{ blockSize: measured.offsetHeight, inlineSize: measured.offsetWidth }],
        } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
      }
    }
  };
  target.ResizeObserver = DeterministicResizeObserver;
  (dom.window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = DeterministicResizeObserver as unknown as typeof ResizeObserver;
}

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
