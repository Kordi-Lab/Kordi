import { measureElement, type Virtualizer } from '@tanstack/react-virtual';

/** Preserve the reading point inside a row when its leading date badge changes. */
export function createTranscriptContentMeasure(isSuspended: () => boolean) {
  const leadingHeights = new WeakMap<HTMLElement, { key: string | number | bigint; height: number }>();
  return (node: HTMLElement, entry: ResizeObserverEntry | undefined, instance: Virtualizer<HTMLDivElement, HTMLElement>) => {
    const index = instance.indexFromElement(node);
    const key = instance.options.getItemKey(index);
    const height = node.querySelector<HTMLElement>('[data-transcript-time-separator]')?.offsetHeight ?? 0;
    const previous = leadingHeights.get(node);
    leadingHeights.set(node, { key, height });
    const delta = previous?.key === key ? height - previous.height : 0;
    const viewport = instance.scrollElement;
    if (delta && viewport && !isSuspended()
      && instance.getVirtualItemForOffset(instance.scrollOffset ?? viewport.scrollTop)?.key === key) {
      // Run after the whole ResizeObserver batch and the virtualizer's prepend
      // adjustment. Only the badge delta is ours; row shifts above are theirs.
      queueMicrotask(() => {
        if (!node.isConnected || instance.scrollElement !== viewport || isSuspended()
          || instance.options.getItemKey(instance.indexFromElement(node)) !== key) return;
        instance.scrollBy(delta, { behavior: 'auto' });
      });
    }
    const size = measureElement(node, entry, instance);
    // The virtualizer only caches a measured size when it differs from the
    // estimate. Remember exact matches too: new metadata can change estimateSize
    // on the next render, which otherwise silently moves already measured rows.
    if (!instance.itemSizeCache.has(key) && size === instance.options.estimateSize(index)) {
      instance.itemSizeCache.set(key, size);
    }
    return size;
  };
}
