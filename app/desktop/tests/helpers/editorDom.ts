import { JSDOM } from 'jsdom';

/**
 * Installs a JSDOM window as the global DOM for headless Tiptap editors.
 * ProseMirror measures layout through Range rects, which JSDOM lacks; they report empty boxes.
 */
export function installEditorDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://desktop.kordi.test' });
  const view = dom.window;
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Object.assign(view.Range.prototype, { getBoundingClientRect: empty, getClientRects: () => [] });
  Object.assign(view.HTMLElement.prototype, { getClientRects: () => [] });
  const target = globalThis as Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: view,
    document: view.document,
    navigator: view.navigator,
    HTMLElement: view.HTMLElement,
    Element: view.Element,
    Node: view.Node,
    getComputedStyle: view.getComputedStyle.bind(view),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  }
  return () => {
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    view.close();
  };
}
