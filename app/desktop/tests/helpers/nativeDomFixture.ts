import { JSDOM } from 'jsdom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { flushReactUpdates } from './transcriptAttachmentDom';
import { waitForReactCondition } from './waitForReactCondition';

export type RecordedNativeCall = { command: string; args: Record<string, unknown> | undefined };
type NativeHandler = (command: string, args: Record<string, unknown> | undefined) => Promise<unknown>;

/**
 * Mounts React into a DOM that looks like the native desktop shell. Every
 * native command the tree sends is recorded before the handler answers it.
 */
export async function mountWithNativeCalls(handler: NativeHandler) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://desktop.kordi.test/',
  });
  const calls: RecordedNativeCall[] = [];
  Object.defineProperty(dom.window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return handler(command, args);
      },
    },
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
  const host = dom.window.document.getElementById('root') as HTMLElement;
  const root: Root = createRoot(host);

  return {
    calls,
    host,
    async render(node: ReactNode) {
      await act(async () => { root.render(node); });
    },
    settle: flushReactUpdates,
    waitFor: waitForReactCondition,
    async close() {
      await act(async () => { root.unmount(); });
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}
