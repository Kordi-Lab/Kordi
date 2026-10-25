export function isRawConversationId(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  return trimmed.startsWith('session:')
    || trimmed.startsWith('bridge:')
    || trimmed.startsWith('draft:');
}

// Subtitles at this layer are session ids or status sentences, so a single token with digits is an id.
export function looksLikeOpaqueId(value: string) {
  return !/\s/.test(value) && /\d/.test(value) && /^[A-Za-z0-9._:@/-]+$/.test(value);
}

export function looksLikeSessionId(value: string) {
  return isRawConversationId(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || looksLikeOpaqueId(value);
}
