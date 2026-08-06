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

import { ScrollArea } from '@/components/ui/scroll-area';
import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import type { ChatSidebarRow } from '@/pages/sidebar/chatSidebarRows';

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
  activeSessionId,
  scrollRef,
  scrollClassName,
  scrollStyle,
  dataMode,
  renderRow,
  emptyState,
}: {
  rows: readonly ChatSidebarRow[];
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
  const renderRowRef = useRef(renderRow);
  renderRowRef.current = renderRow;
  const renderStableRow = useCallback((row: ChatSidebarRow) => renderRowRef.current(row), []);
  const setScrollElement = useCallback((node: HTMLDivElement | null) => {
    internalScrollRef.current = node;
    if (scrollRef) scrollRef.current = node;
  }, [scrollRef]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => internalScrollRef.current,
    estimateSize: () => 56,
    getItemKey: (index) => rows[index]?.key ?? `missing:${index}`,
    overscan: 12,
    useFlushSync: false,
  });
  const activeRowIndex = useMemo(() => {
    const normalizedActiveId = activeSessionId?.trim();
    if (!normalizedActiveId) return -1;
    return rows.findIndex((row) => row.kind === 'session' && row.sessionId === normalizedActiveId);
  }, [activeSessionId, rows]);

  useLayoutEffect(() => {
    if (activeRowIndex < 0) return;
    virtualizer.scrollToIndex(activeRowIndex, { align: 'auto' });
  }, [activeRowIndex, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const renderedVirtualRows = useMemo(() => {
    if (virtualRows.length > 0) return virtualRows;
    const fallbackCount = Math.min(40, rows.length);
    const start = activeRowIndex < 0
      ? 0
      : Math.max(0, Math.min(rows.length - fallbackCount, activeRowIndex - Math.floor(fallbackCount / 2)));
    return Array.from({ length: fallbackCount }, (_, offset) => {
      const index = start + offset;
      return {
        index,
        key: rows[index]?.key ?? `missing:${index}`,
        start: index * 56,
        end: (index + 1) * 56,
        size: 56,
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
