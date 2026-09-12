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
