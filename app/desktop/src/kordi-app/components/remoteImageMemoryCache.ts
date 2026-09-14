import type { RemoteAvatarImageSnapshot } from './remoteAvatarImage';

type Entry = { dataUrl: string; estimatedBytes: number; snapshot: RemoteAvatarImageSnapshot };

class ImageMemoryCache {
  readonly entries = new Map<string, Entry>();
  totalBytes = 0;

  constructor(readonly maxEntries: number, readonly maxBytes: number) {}

  remember(key: string, dataUrl: string) {
    // Count two bytes per character conservatively, even for ASCII data URLs.
    const estimatedBytes = dataUrl.length * 2;
    if (estimatedBytes > this.maxBytes) return;
    this.remove(key);
    while (this.entries.size >= this.maxEntries || this.totalBytes + estimatedBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(key, {
      dataUrl, estimatedBytes,
      snapshot: Object.freeze({ status: 'ready', dataUrl, error: null }),
    });
    this.totalBytes += estimatedBytes;
  }

  touch(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.totalBytes -= entry.estimatedBytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

export const avatarMemoryCache = new ImageMemoryCache(192, 16 * 1024 * 1024);
// Browsing the full catalog must not evict its first page or account avatars.
const notoThumbnailCache = new ImageMemoryCache(1024, 24 * 1024 * 1024);
const notoAnimationCache = new ImageMemoryCache(96, 24 * 1024 * 1024);
export const remoteImageMemoryCaches = [avatarMemoryCache, notoThumbnailCache, notoAnimationCache];

export function remoteImageMemoryCache(key: string) {
  const url = key.slice(key.lastIndexOf('\u0000') + 1);
  const asset = /^https:\/\/fonts\.gstatic\.com\/s\/e\/notoemoji\/latest\/[a-f0-9]+(?:_[a-f0-9]+)*\/(128\.png|512\.(?:png|webp|gif))$/.exec(url);
  if (!asset) return avatarMemoryCache;
  return asset[1] === '128.png' ? notoThumbnailCache : notoAnimationCache;
}
