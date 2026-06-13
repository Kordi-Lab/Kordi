const DEFAULT_CLOUD_ENVELOPE_PARSE_CACHE_LIMIT = 2_000;

type CacheEntry<T> = {
  readonly value: T | null;
};

export function cachedCloudEnvelopeParse<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  parse: () => T | null,
  limit = DEFAULT_CLOUD_ENVELOPE_PARSE_CACHE_LIMIT,
): T | null {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
  }

  const value = parse();
  cache.set(key, { value });
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    cache.delete(oldestKey);
  }
  return value;
}
