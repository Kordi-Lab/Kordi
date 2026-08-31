export const BLOB_EMOJI_TOKEN_ATTRIBUTE = 'data-blob-emoji-token';

export function blobEmojiTokenFor(node: Node) {
  return node instanceof HTMLElement
    ? node.getAttribute(BLOB_EMOJI_TOKEN_ATTRIBUTE)
    : null;
}

export function blobEmojiComposerValue(root: HTMLElement) {
  function value(node: Node): string {
    const token = blobEmojiTokenFor(node);
    if (token) return token;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    return Array.from(node.childNodes).map(value).join('');
  }
  return value(root);
}
