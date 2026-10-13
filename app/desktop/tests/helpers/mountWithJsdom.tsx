import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Mounts React into a throwaway JSDOM window and restores the globals afterwards. */
export async function withJsdomRoot(run: (mount: (element: ReactElement) => Promise<HTMLElement>, root: Root) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://desktop.kordi.test',
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  const host = dom.window.document.getElementById('root');
  assert.ok(host);
  const root = createRoot(host);
  try {
    await run(async (element) => {
      await act(async () => {
        root.render(element);
      });
      return host as unknown as HTMLElement;
    }, root);
  } finally {
    await act(async () => {
      root.unmount();
      // Editors (Tiptap) tear down on a timer after unmount; let it run while the window still exists.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
}
