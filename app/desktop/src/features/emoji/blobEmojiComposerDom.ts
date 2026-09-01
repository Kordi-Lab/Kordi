export const BLOB_EMOJI_TOKEN_ATTRIBUTE = 'data-blob-emoji-token';
export const BLOB_EMOJI_CARET_ANCHOR_ATTRIBUTE = 'data-blob-emoji-caret-anchor';
export const BLOB_EMOJI_CARET_MARKER = '\u200B';

export function blobEmojiTokenFor(node: Node) {
  return node instanceof HTMLElement
    ? node.getAttribute(BLOB_EMOJI_TOKEN_ATTRIBUTE)
    : null;
}

export function blobEmojiCaretAnchorValue(node: Node): string | null {
  if (!(node instanceof HTMLElement) || !node.hasAttribute(BLOB_EMOJI_CARET_ANCHOR_ATTRIBUTE)) {
    return null;
  }
  return (node.textContent ?? '').split(BLOB_EMOJI_CARET_MARKER).join('');
}

export function blobEmojiComposerValue(root: HTMLElement) {
  function value(node: Node): string {
    const token = blobEmojiTokenFor(node);
    if (token) return token;
    const caretAnchor = blobEmojiCaretAnchorValue(node);
    if (caretAnchor !== null) return caretAnchor;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    return Array.from(node.childNodes).map(value).join('');
  }
  return value(root);
}
