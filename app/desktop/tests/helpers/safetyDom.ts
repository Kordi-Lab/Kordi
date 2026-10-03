import { act, type ReactElement } from 'react';

import { flushReactUpdates, installDom } from './transcriptAttachmentDom';

/**
 * Mounts React into a fresh jsdom document. The client renderer is loaded
 * after the DOM exists so it uses native input events.
 */
export async function mountInDom() {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const document = installed.dom.window.document;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const window = installed.dom.window;

  const findButton = (label: string | RegExp) => [...document.querySelectorAll('button')].find((button) => (
    typeof label === 'string' ? button.textContent?.trim() === label : label.test(button.textContent ?? '')
  )) as HTMLButtonElement | undefined;

  return {
    window,
    document,
    host,
    async render(element: ReactElement) {
      await act(async () => { root.render(element); });
      await flushReactUpdates();
    },
    findButton,
    async click(target: HTMLElement | undefined) {
      if (!target) throw new Error('missing click target');
      await act(async () => { target.click(); });
      await flushReactUpdates();
    },
    async type(target: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
      if (!target) throw new Error('missing input');
      const prototype = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, value);
        target.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async keydown(key: string) {
      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
      });
    },
    text() {
      return document.body.textContent ?? '';
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      installed.restore();
    },
  };
}

export type StubbedRequest = { method: string; path: string; body: unknown };

/**
 * Routes every hosted API request to `respond` and disables realtime sockets,
 * so components that create their own default client never reach a network.
 */
export function stubCloudNetwork(respond: (request: StubbedRequest) => Response | Promise<Response>) {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const previousSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const requests: StubbedRequest[] = [];
  Object.defineProperty(target, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const request = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
      };
      requests.push(request);
      return respond(request);
    },
  });
  Object.defineProperty(target, 'WebSocket', { configurable: true, writable: true, value: undefined });
  return {
    requests,
    restore() {
      if (previousFetch) Object.defineProperty(target, 'fetch', previousFetch);
      if (previousSocket) Object.defineProperty(target, 'WebSocket', previousSocket);
      else delete target.WebSocket;
    },
  };
}
