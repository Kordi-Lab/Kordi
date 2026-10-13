const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A stable block id: `k:` plus 8 characters of `[a-z0-9]`. No Tiptap import, so the reader can use it before the editor loads. */
export function newBlockId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `k:${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`;
}
