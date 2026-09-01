function safeMentionCharacters(value: string) {
  return value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.join('') ?? '';
}

export function mentionHandleForLabel(value: string, fallback = 'Participant') {
  const handle = safeMentionCharacters(value) || safeMentionCharacters(fallback) || 'Participant';
  return handle.slice(0, 64);
}

export function normalizeMentionLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
