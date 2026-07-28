import { getCurrentWindow } from '@tauri-apps/api/window';
import type { MouseEventHandler, ReactNode } from 'react';

import { shouldStartNativeWindowDrag } from '@/app/windowDrag';
import { LEFT_RAIL_WIDTH } from '@/kordi-app/layout';
import { cn } from '@/lib/utils';

type AppShellFrameProps = {
  rootThemeClass: string;
  isNativeShell: boolean;
  isLayoutResizing: boolean;
  windowSize: { width: number; height: number };
  leftWorkspaceWidth: number;
  isSingleWorkspacePage: boolean;
  showSessionRail: boolean;
  collapseChatSessions: boolean;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  detailRailWidth: number;
  onSessionResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  onDetailResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  sidebar: ReactNode;
  mainContent: ReactNode;
  rightDetailRail?: ReactNode;
  authGate?: ReactNode;
  inlineAuthDialog?: ReactNode;
  messageForwardDialog?: ReactNode;
  windowResizeHandles?: ReactNode;
};

export function AppShellFrame({
  rootThemeClass,
  isNativeShell,
  isLayoutResizing,
  windowSize,
  leftWorkspaceWidth,
  isSingleWorkspacePage,
  showSessionRail,
  collapseChatSessions,
  showRightDetailRail,
  isDetailPanelCollapsed,
  detailRailWidth,
  onSessionResizeMouseDown,
  onDetailResizeMouseDown,
  sidebar,
  mainContent,
  rightDetailRail,
  authGate,
  inlineAuthDialog,
  messageForwardDialog,
  windowResizeHandles,
}: AppShellFrameProps) {
  const handleNativeWindowDragMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!shouldStartNativeWindowDrag({
      isNativeShell,
      button: event.button,
      clientY: event.clientY,
      shellTop: event.currentTarget.getBoundingClientRect().top,
      target: event.target,
    })) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  return (
    <div
      className={cn(
        'kordi-app app-page-bg w-full min-w-0 max-w-full text-[13px] text-foreground',
        rootThemeClass,
        isNativeShell ? 'h-[100dvh] overflow-hidden p-0' : 'min-h-screen p-4 md:p-6',
      )}
    >
      <div
        className={cn(
          'app-shell relative flex min-w-0 max-w-full flex-col overflow-hidden',
          isLayoutResizing ? 'backdrop-blur-none' : 'backdrop-blur-2xl',
          isNativeShell
            ? 'h-full w-full rounded-none border-0 shadow-none'
            : 'app-shell-preview mx-auto rounded-[26px] border',
          !isNativeShell && isLayoutResizing && 'app-shell-resizing',
        )}
        onMouseDownCapture={isNativeShell ? handleNativeWindowDragMouseDown : undefined}
        style={
          isNativeShell
            ? undefined
            : { width: `${windowSize.width}px`, height: `${windowSize.height}px` }
        }
      >
        {isNativeShell ? (
          <>
            <div
              className="pointer-events-auto absolute left-0 top-0 z-40 h-11"
              style={{ width: `${LEFT_RAIL_WIDTH}px`, WebkitAppRegion: 'drag' as const }}
              data-tauri-drag-region="true"
              aria-hidden="true"
            />
            {leftWorkspaceWidth > LEFT_RAIL_WIDTH ? (
              <div
                className="pointer-events-auto absolute top-0 z-40 h-11"
                style={{
                  left: `${LEFT_RAIL_WIDTH}px`,
                  width: `${leftWorkspaceWidth - LEFT_RAIL_WIDTH}px`,
                  WebkitAppRegion: 'drag' as const,
                }}
                data-tauri-drag-region="true"
                aria-hidden="true"
              />
            ) : null}
          </>
        ) : null}
        <div
          className={cn(
            'relative grid h-full min-w-0 flex-1 gap-0 overflow-hidden box-border',
            isLayoutResizing ? 'transition-none' : 'transition-[grid-template-columns]',
          )}
          style={{
            gridTemplateColumns: `${leftWorkspaceWidth}px minmax(0, 1fr)`,
          }}
        >
          {sidebar}
          {showSessionRail && !collapseChatSessions && (
            <div
              onMouseDown={onSessionResizeMouseDown}
              className="absolute bottom-0 top-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${leftWorkspaceWidth}px` }}
              data-kordi-window-drag="false"
              aria-hidden="true"
            >
              <div className="mx-auto h-full w-px bg-white/8 transition hover:bg-white/20" />
            </div>
          )}

          <section
            className={cn(
              'relative min-h-0 min-w-0 overflow-hidden',
              isSingleWorkspacePage ? 'app-main-panel rounded-none border-0' : 'app-main-panel rounded-br-[22px] rounded-l-none border-l border-white/10',
            )}
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            <div
              className={cn(
                'grid h-full min-h-0 min-w-0',
                isLayoutResizing ? 'transition-none' : 'transition-[grid-template-columns] duration-300',
              )}
              style={{
                gridTemplateColumns: showRightDetailRail && !isDetailPanelCollapsed ? `minmax(0, 1fr) ${detailRailWidth}px` : 'minmax(0, 1fr)',
                gridTemplateRows: 'minmax(0, 1fr)',
              }}
            >
              <main className="flex h-full min-h-0 min-w-0 overflow-hidden">
                {mainContent}
              </main>

              {showRightDetailRail && !isDetailPanelCollapsed ? rightDetailRail : null}
              {showRightDetailRail && !isDetailPanelCollapsed && (
                <div
                  onMouseDown={onDetailResizeMouseDown}
                  className="absolute bottom-0 top-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize"
                  style={{ left: `calc(100% - ${detailRailWidth}px)` }}
                  data-kordi-window-drag="false"
                  aria-hidden="true"
                >
                  <div className="mx-auto h-full w-px bg-white/8 transition hover:bg-white/20" />
                </div>
              )}
            </div>
          </section>
        </div>
        {authGate}
        {inlineAuthDialog}
        {messageForwardDialog}
        {!isNativeShell ? windowResizeHandles : null}
      </div>
    </div>
  );
}
