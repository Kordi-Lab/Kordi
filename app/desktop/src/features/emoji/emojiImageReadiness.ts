const MAX_READY_EMOJI_IMAGES = 1_024;
const readyEmojiImages = new Set<string>();

export function isEmojiImageReady(key: string): boolean {
  return readyEmojiImages.has(key);
}

export function markEmojiImageReady(key: string): void {
  readyEmojiImages.delete(key);
  readyEmojiImages.add(key);
  while (readyEmojiImages.size > MAX_READY_EMOJI_IMAGES) {
    const oldest = readyEmojiImages.values().next().value;
    if (!oldest) break;
    readyEmojiImages.delete(oldest);
  }
}

export function clearEmojiImageReadinessForTests(): void {
  readyEmojiImages.clear();
}
