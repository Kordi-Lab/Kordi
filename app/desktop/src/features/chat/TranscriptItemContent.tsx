import type { VirtualItem } from '@tanstack/react-virtual';
import { TRANSCRIPT_NAVIGATION_HIGHLIGHT_CLASS } from './useVirtualTranscriptNavigation';
import { memo, type ReactNode } from 'react';

function TranscriptItemContent<Item>({ item, index, renderItem }: {
  item: Item;
  index: number;
  renderItem: (item: Item, index: number) => ReactNode;
}) {
  return renderItem(item, index);
}

// Geometry and scroll updates move the row shell without rebuilding its content.
export const MemoizedTranscriptItemContent = memo(TranscriptItemContent) as typeof TranscriptItemContent;

export function TranscriptWindowRows<Item>({ items, virtualItems, measureElement, navigationTargetIndex, renderItem }: {
  items: readonly Item[];
  virtualItems: VirtualItem[];
  measureElement: (node: HTMLDivElement | null) => void;
  navigationTargetIndex: number;
  renderItem: (item: Item, index: number) => ReactNode;
}) {
  return <>
            {virtualItems.map((virtualItem) => {
              const item = items[virtualItem.index];
              if (item === undefined) return null;
              return (
                <div
                  key={virtualItem.key}
                  ref={measureElement}
                  data-index={virtualItem.index}
                  data-transcript-row-key={String(virtualItem.key)}
                  data-transcript-window-item="true"
                  className={`absolute left-0 top-0 w-full${
                    virtualItem.index === navigationTargetIndex
                      ? ` ${TRANSCRIPT_NAVIGATION_HIGHLIGHT_CLASS}`
                      : ''
                  }`}
                >
                  <MemoizedTranscriptItemContent item={item} index={virtualItem.index} renderItem={renderItem} />
                </div>
              );
            })}
  </>;
}
