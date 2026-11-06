// UTF-8 base64url coding for cloud message envelopes (group controls, agent
// responses, direct messages). Envelope bodies are immutable once sent, yet the
// app derives unread counts, previews and replay rows from the same bodies on
// every sync and render. Decoding a body once and reusing the text keeps that
// work off the main thread's hot path.

const DECODED_CACHE_MAX_ENTRIES = 4_096;
const DECODED_CACHE_MAX_CHARS = 8_000_000;
const decoded = new Map<string, string>();
let decodedChars = 0;

function rememberDecoded(encoded: string, text: string) {
  const previous = decoded.get(encoded);
  if (previous !== undefined) {
    decoded.delete(encoded);
    decodedChars -= encoded.length + previous.length;
  }
  decoded.set(encoded, text);
  decodedChars += encoded.length + text.length;
  while (decoded.size > DECODED_CACHE_MAX_ENTRIES || decodedChars > DECODED_CACHE_MAX_CHARS) {
    const oldest = decoded.keys().next();
    if (oldest.done) break;
    decodedChars -= oldest.value.length + (decoded.get(oldest.value)?.length ?? 0);
    decoded.delete(oldest.value);
  }
}

/** Encodes UTF-8 text as unpadded base64url. */
export function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  // Chunks keep each call within argument limits without building a rope of
  // one-character strings.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000) as unknown as number[]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decodes base64url (padded or not) into UTF-8 text. Results are cached by the
 * encoded value; invalid input throws exactly like `atob` and is not cached.
 */
export function decodeBase64UrlUtf8(value: string): string {
  const cached = decoded.get(value);
  if (cached !== undefined) {
    // Refresh recency so bodies still on screen are evicted last.
    decoded.delete(value);
    decoded.set(value, cached);
    return cached;
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const text = new TextDecoder().decode(bytes);
  rememberDecoded(value, text);
  return text;
}

/** Test hook: forgets decoded envelopes. */
export function __resetCloudBase64UrlCacheForTests() {
  decoded.clear();
  decodedChars = 0;
}
