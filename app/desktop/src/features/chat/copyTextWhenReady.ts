/**
 * Copies text that is still on its way, such as a link the server is making.
 *
 * WebKit only lets a page write to the clipboard during the click, so where
 * the browser accepts a pending `ClipboardItem` the write starts right away
 * and waits for the text. Elsewhere the text is written once it arrives.
 * Rejects when the text never arrives or the clipboard refuses it.
 */
export function copyTextWhenReady(text: Promise<string>): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) {
    void text.catch(() => undefined);
    return Promise.reject(new Error('The clipboard is unavailable.'));
  }
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
    // A refused write may reject before the clipboard reads the pending text.
    void blob.catch(() => undefined);
    return clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  }
  return text.then((value) => clipboard.writeText(value));
}
