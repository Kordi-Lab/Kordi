import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject, type RefCallback,
} from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { estimatedChatSidebarRowSize, type ChatSidebarRow } from './chatSidebarRows';
import type { Virtualizer } from '@tanstack/react-virtual';
import {
  CHANNEL_HEIGHT, HEADER_HEIGHT,
  visibleChannelRange, type ParticipantSpaceBlock,
} from './participantSpaceLayout';

function ParticipantSpaceBlockView({ block, top, scrollTop, viewportHeight, renderRow, compactChannels }: {
  block: ParticipantSpaceBlock;
  compactChannels: boolean;
  top: number;
  scrollTop: number;
  viewportHeight: number;
  renderRow: (row: ChatSidebarRow) => ReactNode;
}) {
  const [previousChannels, setPreviousChannels] = useState(block.channels);
  const [retainedChannels, setRetainedChannels] = useState(block.channels);
  // Retain exiting rows until the clip closes. Reopening reuses their keys.
  if (previousChannels !== block.channels) {
    setPreviousChannels(block.channels);
    if (block.channels.length > 0) setRetainedChannels(block.channels);
  }
  const expanded = block.channels.length > 0;
  const channels = expanded ? block.channels : retainedChannels;
  useEffect(() => {
    if (expanded || retainedChannels.length === 0) return;
    const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
    const timer = window.setTimeout(() => setRetainedChannels([]), delay);
    return () => window.clearTimeout(timer);
  }, [expanded, retainedChannels]);
  const offsets = useMemo(() => {
    const positions = [0];
    for (const row of channels) positions.push(positions[positions.length - 1] + (compactChannels ? estimatedChatSidebarRowSize(row) : CHANNEL_HEIGHT));
    return positions;
  }, [channels, compactChannels]);
  const contentHeight = offsets[offsets.length - 1];
  const headerHeight = compactChannels ? estimatedChatSidebarRowSize(block.header) : HEADER_HEIGHT;
  const range = visibleChannelRange(channels.length, scrollTop - top - headerHeight, viewportHeight);
  let low = 0;
  let high = offsets.length;
  const target = scrollTop - top - headerHeight;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] < target) low = middle + 1; else high = middle;
  }
  const start = compactChannels ? Math.max(0, Math.min(channels.length, low) - 5) : range.start;
  const end = compactChannels ? Math.min(channels.length, start + Math.ceil(viewportHeight / 26) + 10) : range.end;
  return (
    <>
      <div data-chat-sidebar-row={block.header.key}>{renderRow(block.header)}</div>
      <div className="app-participant-channel-reveal"
        style={{ height: expanded ? contentHeight : 0 }}
        aria-hidden={!expanded} inert={!expanded}>
        <div className="relative w-full" style={{ height: contentHeight }}>
          {channels.slice(start, end).map((row, offset) => (
            <div key={row.key} data-chat-sidebar-row={row.key} className="absolute left-0 top-0 w-full"
              style={{ height: offsets[start + offset + 1] - offsets[start + offset], transform: `translateY(${offsets[start + offset]}px)` }}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Virtualize spaces and their channel windows independently. Measuring the
 * animated clip keeps neighboring rows and the scroll extent in step, while
 * the channel content retains its identity, position and opacity.
 */
export function VirtualParticipantSpaceList({
  blocks, virtualizer, scrollRef, setScrollElement, activeSessionId, compactChannels = false, scrollClassName, scrollStyle, dataMode, renderRow, emptyState,
}: {
  blocks: ParticipantSpaceBlock[];
  compactChannels?: boolean;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: RefObject<HTMLDivElement | null>;
  setScrollElement: RefCallback<HTMLDivElement>;
  activeSessionId?: string | null;
  scrollClassName?: string;
  scrollStyle?: CSSProperties;
  dataMode?: string;
  renderRow: (row: ChatSidebarRow) => ReactNode;
  emptyState?: ReactNode;
}) {
  const scrolledSession = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Raw scroll events fire far more often than the compositor needs (every
  // trackpad tick, not every frame); coalesce them into one React update per
  // animation frame instead of re-rendering this list and every visible
  // block on each tick. Read the latest value inside the frame callback
  // (not at schedule time) so several events landing in the same frame
  // still commit the most recent position, not the first.
  const pendingScrollFrame = useRef(0);
  const latestScrollTop = useRef(0);
  const handleScroll = useCallback((event: { currentTarget: { scrollTop: number } }) => {
    latestScrollTop.current = event.currentTarget.scrollTop;
    if (pendingScrollFrame.current) return;
    pendingScrollFrame.current = requestAnimationFrame(() => {
      pendingScrollFrame.current = 0;
      setScrollTop(latestScrollTop.current);
    });
  }, []);
  useEffect(() => () => {
    if (pendingScrollFrame.current) cancelAnimationFrame(pendingScrollFrame.current);
  }, []);
  const viewportHeight = virtualizer.scrollRect?.height || 600;
  const totalSize = virtualizer.getTotalSize();
  const activeBlockIndex = useMemo(() => blocks.findIndex(block => block.channels.some(
    row => row.kind === 'session' && row.sessionId === activeSessionId,
  )), [activeSessionId, blocks]);
  const activeBlockSize = virtualizer.measurementsCache[activeBlockIndex]?.size;
  const activeBlockStart = virtualizer.measurementsCache[activeBlockIndex]?.start;
  useLayoutEffect(() => {
    if (!activeSessionId) { scrolledSession.current = null; return; }
    if (scrolledSession.current === activeSessionId) return;
    const blockIndex = activeBlockIndex;
    if (blockIndex < 0) { scrolledSession.current = null; return; }
    const block = blocks[blockIndex];
    const channelIndex = block.channels.findIndex(row => row.kind === 'session' && row.sessionId === activeSessionId);
    const viewport = scrollRef.current;
    if (!viewport) return;
    const groupElement = viewport.querySelector<HTMLElement>(`[data-participant-space-block][data-index="${blockIndex}"]`);
    if (!groupElement) {
      virtualizer.scrollToIndex(blockIndex, { align: 'auto' });
      return;
    }
    const clip = groupElement.querySelector<HTMLElement>('.app-participant-channel-reveal');
    // A newly selected group may still have its collapsed measurement. Keep
    // the selection pending until the clip and scroll extent can reveal it.
    if (clip && clip.offsetHeight + 1 < block.channels.reduce((total, row) => total + (compactChannels ? estimatedChatSidebarRowSize(row) : CHANNEL_HEIGHT), 0)) return;
    const groupTop = virtualizer.measurementsCache[blockIndex]?.start ?? 0;
    const headerHeight = (groupElement.firstElementChild as HTMLElement | null)?.offsetHeight ?? HEADER_HEIGHT;
    const channelTop = groupTop + headerHeight + block.channels.slice(0, channelIndex).reduce((total, row) => total + (compactChannels ? estimatedChatSidebarRowSize(row) : CHANNEL_HEIGHT), 0);
    const channelHeight = compactChannels ? estimatedChatSidebarRowSize(block.channels[channelIndex]) : CHANNEL_HEIGHT;
    if (channelTop + channelHeight > totalSize + 1) return;
    if (channelTop < viewport.scrollTop) virtualizer.scrollToOffset(channelTop);
    else if (channelTop + channelHeight > viewport.scrollTop + viewportHeight) {
      virtualizer.scrollToOffset(channelTop + channelHeight - viewportHeight);
    }
    if (channelTop >= viewport.scrollTop - 1 && channelTop + channelHeight <= viewport.scrollTop + viewportHeight + 1) {
      scrolledSession.current = activeSessionId;
    }
  }, [activeBlockIndex, activeBlockSize, activeBlockStart, activeSessionId, blocks, scrollRef, scrollTop, totalSize, viewportHeight, virtualizer, compactChannels]);
  const virtualRows = virtualizer.getVirtualItems();
  const visibleBlocks = virtualRows.length ? virtualRows : blocks.slice(0, 12).map((block, index) => ({
    index, key: block.header.key,
    start: blocks.slice(0, index).reduce((height, item) => height + (compactChannels ? estimatedChatSidebarRowSize(item.header) : HEADER_HEIGHT) + item.channels.reduce((total, row) => total + (compactChannels ? estimatedChatSidebarRowSize(row) : CHANNEL_HEIGHT), 0), 0),
  }));
  return (
    <ScrollArea ref={setScrollElement} className={scrollClassName} style={scrollStyle}
      data-virtual-chat-list="true" data-chat-sidebar-mode={dataMode}
      onScroll={handleScroll}
      onKeyDownCapture={event => { event.currentTarget.dataset.channelKeyboardMotion = 'true'; }}
      onPointerDownCapture={event => { delete event.currentTarget.dataset.channelKeyboardMotion; }}>
      {blocks.length ? (
        <div className="relative w-full" data-virtual-chat-list-size="true" style={{ height: totalSize }}>
          {visibleBlocks.map(item => (
            <div key={item.key} ref={virtualizer.measureElement} data-index={item.index}
              data-participant-space-block="true" className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}>
              <ParticipantSpaceBlockView block={blocks[item.index]} top={item.start} scrollTop={scrollTop}
                viewportHeight={viewportHeight} compactChannels={compactChannels} renderRow={renderRow}/>
            </div>
          ))}
        </div>
      ) : emptyState}
    </ScrollArea>
  );
}
