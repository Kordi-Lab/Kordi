import { measureElement, type Virtualizer } from '@tanstack/react-virtual';

/** Preserve the reading point when paging changes a row's date or sender header. */
export function createTranscriptContentMeasure(isSuspended: () => boolean) {
  const leadingHeights = new WeakMap<HTMLElement, { key: string | number | bigint; height: number; index: number }>();
  return (node: HTMLElement, entry: ResizeObserverEntry | undefined, instance: Virtualizer<HTMLDivElement, HTMLElement>) => {
    const index = instance.indexFromElement(node);
    const key = instance.options.getItemKey(index);
    let height = node.querySelector<HTMLElement>('[data-transcript-time-separator]')?.offsetHeight ?? 0;
    for (const decoration of node.querySelectorAll<HTMLElement>('[data-transcript-leading-decoration]')) {
      const style = getComputedStyle(decoration);
      height += decoration.offsetHeight + (Number.parseFloat(style.marginTop) || 0)
        + (Number.parseFloat(style.marginBottom) || 0);
    }
    const previous = leadingHeights.get(node);
    leadingHeights.set(node, { key, height, index });
    const delta = previous?.key === key ? height - previous.height : 0;
    const viewport = instance.scrollElement;
    const scrollOffset = instance.scrollOffset ?? viewport?.scrollTop ?? 0;
    // Before a prepend, the first row can start below the viewport's padding.
    // The restored offset then falls in a newly inserted row just above it.
    const wasPaddedFirstRow = previous?.index === 0 && index > 0
      && instance.getVirtualItemForOffset(scrollOffset + instance.options.scrollMargin)?.key === key;
    if (delta && viewport && !isSuspended()
      && (wasPaddedFirstRow || instance.getVirtualItemForOffset(scrollOffset)?.key === key)) {
      // Run after the whole ResizeObserver batch and the virtualizer's prepend
      // adjustment. Only the leading decoration delta is ours; row shifts above
      // are theirs. Grouping can remove a sender header with the date badge.
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
