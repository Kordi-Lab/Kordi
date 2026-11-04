import type { DOMWindow } from 'jsdom';

/** Model dialog open/close state where JSDOM lacks the native lifecycle methods. */
export function installDialogDom(window: DOMWindow) {
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
}
