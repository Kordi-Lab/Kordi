import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  memo,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { VirtualParticipantSpaceList } from './VirtualParticipantSpaceList';
import { CHANNEL_HEIGHT, HEADER_HEIGHT, participantSpaceBlocks } from './participantSpaceLayout';

import { ScrollArea } from '@/components/ui/scroll-area';
import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  estimatedChatSidebarRowSize,
  type ChatSidebarRow,
} from '@/pages/sidebar/chatSidebarRows';

export { buildChatSidebarRows } from '@/pages/sidebar/chatSidebarRows';
export type {
  ChatSidebarRow,
  ChatSidebarSessionInput,
  ChatSidebarSpaceInput,
} from '@/pages/sidebar/chatSidebarRows';

const SpaceRow = memo(function SpaceRow({
  row,
  renderRow,
}: {
  row: Extract<ChatSidebarRow, { kind: 'space' }>;
  renderRow: (row: ChatSidebarRow) => ReactNode;
}) {
  return renderRow(row);
});

const SessionRow = memo(function SessionRow({
  row,
  renderRow,
}: {
  row: Extract<ChatSidebarRow, { kind: 'session' }>;
  renderRow: (row: ChatSidebarRow) => ReactNode;
}) {
  return renderRow(row);
});

export function VirtualChatList({
  rows,
  groupChannels = false,
  activeSessionId,
  scrollRef,
  scrollClassName,
  scrollStyle,
  dataMode,
  renderRow,
  emptyState,
}: {
  rows: readonly ChatSidebarRow[];
  groupChannels?: boolean;
  activeSessionId?: string | null;
  scrollRef?: RefObject<HTMLDivElement | null>;
  scrollClassName?: string;
  scrollStyle?: CSSProperties;
  dataMode?: string;
  renderRow: (row: ChatSidebarRow) => ReactNode;
  emptyState?: ReactNode;
}) {
  const renderPerformanceSpan = beginChatPerformanceSpan('sidebar-virtual-render');
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledActiveSessionIdRef = useRef<string | null>(null);
  const renderRowRef = useRef(renderRow);
  renderRowRef.current = renderRow;
  const renderStableRow = useCallback((row: ChatSidebarRow) => renderRowRef.current(row), []);
  const setScrollElement = useCallback((node: HTMLDivElement | null) => {
    internalScrollRef.current = node;
    if (scrollRef) scrollRef.current = node;
  }, [scrollRef]);
  const blocks = useMemo(() => groupChannels ? participantSpaceBlocks(rows) : [], [groupChannels, rows]);
  const virtualizer = useVirtualizer({
    count: groupChannels ? blocks.length : rows.length,
    getScrollElement: () => internalScrollRef.current,
    estimateSize: (index) => groupChannels
      ? HEADER_HEIGHT + blocks[index].channels.length * CHANNEL_HEIGHT
      : estimatedChatSidebarRowSize(rows[index]),
    getItemKey: (index) => (groupChannels ? blocks[index]?.header.key : rows[index]?.key) ?? `missing:${index}`,
    overscan: groupChannels ? 4 : rows.length <= 100 ? rows.length : 24,
    useFlushSync: false,
    directDomUpdates: !groupChannels,
    directDomUpdatesMode: 'transform',
  });
  useLayoutEffect(() => {
    if (!groupChannels) return;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
      item.end <= (instance.scrollOffset ?? 0)
    );
    return () => { virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined; };
  }, [groupChannels, virtualizer]);
  const activeRowIndex = useMemo(() => {
    const normalizedActiveId = activeSessionId?.trim();
    if (!normalizedActiveId) return -1;
    return rows.findIndex((row) => row.kind === 'session' && row.sessionId === normalizedActiveId);
  }, [activeSessionId, rows]);

  useLayoutEffect(() => {
    if (groupChannels) return;
    const normalizedActiveId = activeSessionId?.trim() || null;
    if (!normalizedActiveId) {
      scrolledActiveSessionIdRef.current = null;
      return;
    }
    if (
      activeRowIndex < 0
      || scrolledActiveSessionIdRef.current === normalizedActiveId
    ) return;
    scrolledActiveSessionIdRef.current = normalizedActiveId;
    virtualizer.scrollToIndex(activeRowIndex, { align: 'auto' });
  }, [activeRowIndex, activeSessionId, groupChannels, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const renderedVirtualRows = useMemo(() => {
    if (virtualRows.length > 0) return virtualRows;
    const fallbackCount = Math.min(40, rows.length);
    const start = activeRowIndex < 0
      ? 0
      : Math.max(0, Math.min(rows.length - fallbackCount, activeRowIndex - Math.floor(fallbackCount / 2)));
    return Array.from({ length: fallbackCount }, (_, offset) => {
      const index = start + offset;
      const size = estimatedChatSidebarRowSize(rows[index]);
      const rowStart = rows.slice(0, index).reduce(
        (total, row) => total + estimatedChatSidebarRowSize(row),
        0,
      );
      return {
        index,
        key: rows[index]?.key ?? `missing:${index}`,
        start: rowStart,
        end: rowStart + size,
        size,
        lane: 0,
      };
    });
  }, [activeRowIndex, rows, virtualRows]);
  useLayoutEffect(() => {
    finishChatPerformanceSpan(renderPerformanceSpan, {
      rowCount: rows.length,
      visibleRowCount: renderedVirtualRows.length,
    });
  }, [renderPerformanceSpan, renderedVirtualRows.length, rows.length]);
  if (groupChannels) {
    return <VirtualParticipantSpaceList blocks={blocks} virtualizer={virtualizer}
      scrollRef={internalScrollRef} activeSessionId={activeSessionId}
      scrollClassName={scrollClassName} scrollStyle={scrollStyle} dataMode={dataMode}
      renderRow={renderRow} emptyState={emptyState}/>;
  }
  return (
    <ScrollArea
      ref={setScrollElement}
      className={scrollClassName}
      style={scrollStyle}
      data-virtual-chat-list="true"
      data-chat-sidebar-mode={dataMode}
    >
      {rows.length > 0 ? (
        <div
          data-virtual-chat-list-size="true"
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {renderedVirtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-chat-sidebar-row={row.key}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {row.kind === 'space'
                  ? <SpaceRow row={row} renderRow={renderStableRow} />
                  : <SessionRow row={row} renderRow={renderStableRow} />}
              </div>
            );
          })}
        </div>
      ) : emptyState}
    </ScrollArea>
  );
}
