import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject, type RefCallback,
} from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import type { ChatSidebarRow } from './chatSidebarRows';
import type { Virtualizer } from '@tanstack/react-virtual';
import {
  CHANNEL_HEIGHT, HEADER_HEIGHT,
  visibleChannelRange, type ParticipantSpaceBlock,
} from './participantSpaceLayout';

function ParticipantSpaceBlockView({ block, top, scrollTop, viewportHeight, renderRow }: {
  block: ParticipantSpaceBlock;
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
  const { start, end } = visibleChannelRange(
    channels.length, scrollTop - top - HEADER_HEIGHT, viewportHeight,
  );
  return (
    <>
      <div data-chat-sidebar-row={block.header.key}>{renderRow(block.header)}</div>
      <div className="app-participant-channel-reveal"
        style={{ height: expanded ? channels.length * CHANNEL_HEIGHT : 0 }}
        aria-hidden={!expanded} inert={!expanded}>
        <div className="relative w-full" style={{ height: channels.length * CHANNEL_HEIGHT }}>
          {channels.slice(start, end).map((row, offset) => (
            <div key={row.key} data-chat-sidebar-row={row.key} className="absolute left-0 top-0 w-full"
              style={{ height: CHANNEL_HEIGHT, transform: `translateY(${(start + offset) * CHANNEL_HEIGHT}px)` }}>
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
  blocks, virtualizer, scrollRef, setScrollElement, activeSessionId, scrollClassName, scrollStyle, dataMode, renderRow, emptyState,
}: {
  blocks: ParticipantSpaceBlock[];
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
    if (clip && clip.offsetHeight + 1 < block.channels.length * CHANNEL_HEIGHT) return;
    const groupTop = virtualizer.measurementsCache[blockIndex]?.start ?? 0;
    const headerHeight = (groupElement.firstElementChild as HTMLElement | null)?.offsetHeight ?? HEADER_HEIGHT;
    const channelTop = groupTop + headerHeight + channelIndex * CHANNEL_HEIGHT;
    if (channelTop + CHANNEL_HEIGHT > totalSize + 1) return;
    if (channelTop < viewport.scrollTop) virtualizer.scrollToOffset(channelTop);
    else if (channelTop + CHANNEL_HEIGHT > viewport.scrollTop + viewportHeight) {
      virtualizer.scrollToOffset(channelTop + CHANNEL_HEIGHT - viewportHeight);
    }
    if (channelTop >= viewport.scrollTop - 1 && channelTop + CHANNEL_HEIGHT <= viewport.scrollTop + viewportHeight + 1) {
      scrolledSession.current = activeSessionId;
    }
  }, [activeBlockIndex, activeBlockSize, activeBlockStart, activeSessionId, blocks, scrollRef, scrollTop, totalSize, viewportHeight, virtualizer]);
  const virtualRows = virtualizer.getVirtualItems();
  const visibleBlocks = virtualRows.length ? virtualRows : blocks.slice(0, 12).map((block, index) => ({
    index, key: block.header.key,
    start: blocks.slice(0, index).reduce((height, item) => height + HEADER_HEIGHT + item.channels.length * CHANNEL_HEIGHT, 0),
  }));
  return (
    <ScrollArea ref={setScrollElement} className={scrollClassName} style={scrollStyle}
      data-virtual-chat-list="true" data-chat-sidebar-mode={dataMode}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDownCapture={event => { event.currentTarget.dataset.channelKeyboardMotion = 'true'; }}
      onPointerDownCapture={event => { delete event.currentTarget.dataset.channelKeyboardMotion; }}>
      {blocks.length ? (
        <div className="relative w-full" data-virtual-chat-list-size="true" style={{ height: totalSize }}>
          {visibleBlocks.map(item => (
            <div key={item.key} ref={virtualizer.measureElement} data-index={item.index}
              data-participant-space-block="true" className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}>
              <ParticipantSpaceBlockView block={blocks[item.index]} top={item.start} scrollTop={scrollTop}
                viewportHeight={viewportHeight} renderRow={renderRow}/>
            </div>
          ))}
        </div>
      ) : emptyState}
    </ScrollArea>
  );
}
