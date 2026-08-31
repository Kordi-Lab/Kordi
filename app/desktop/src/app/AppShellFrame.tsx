import { getCurrentWindow } from '@tauri-apps/api/window';
import type { MouseEventHandler, ReactNode } from 'react';

import {
  APP_WINDOW_RESIZE_EDGE,
  nativeWindowResizeDirection,
  shouldStartNativeWindowDrag,
} from '@/app/windowDrag';
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
  messageDeleteDialog?: ReactNode;
  windowResizeHandles?: ReactNode;
  callOverlay?: ReactNode;
};

function previewInstanceLabel() {
  if (!import.meta.env.DEV) return null;
  const configuredTitle = (import.meta.env as { VITE_KORDI_WINDOW_TITLE?: string })
    .VITE_KORDI_WINDOW_TITLE?.trim();
  return configuredTitle && configuredTitle !== 'Kordi' ? configuredTitle : null;
}

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
  messageDeleteDialog,
  windowResizeHandles,
  callOverlay,
}: AppShellFrameProps) {
  const instanceLabel = previewInstanceLabel();
  const handleNativeWindowDragMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    const shellBounds = event.currentTarget.getBoundingClientRect();
    const resizeDirection = nativeWindowResizeDirection({
      isNativeShell,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      shellBounds,
    });

    if (resizeDirection) {
      event.preventDefault();
      event.stopPropagation();
      void getCurrentWindow().startResizeDragging(resizeDirection).catch(() => undefined);
      return;
    }

    if (!shouldStartNativeWindowDrag({
      isNativeShell,
      button: event.button,
      clientY: event.clientY,
      shellTop: shellBounds.top,
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
        isNativeShell ? 'app-native-viewport overflow-hidden p-0' : 'min-h-screen p-4 md:p-6',
      )}
    >
      <div
        className={cn(
          'app-shell relative flex min-w-0 max-w-full flex-col overflow-hidden',
          !isNativeShell && 'backdrop-blur-2xl',
          isNativeShell
            ? 'h-full w-full rounded-none border-0 shadow-none'
            : 'app-shell-preview mx-auto rounded-[26px] border',
        )}
        data-layout-resizing={isLayoutResizing ? 'true' : undefined}
        onMouseDownCapture={isNativeShell ? handleNativeWindowDragMouseDown : undefined}
        style={
          isNativeShell
            ? undefined
            : { width: `${windowSize.width}px`, height: `${windowSize.height}px` }
        }
      >
        {instanceLabel ? (
          <div className="app-preview-instance-label" aria-label={`Preview instance: ${instanceLabel}`}>
            Preview · {instanceLabel}
          </div>
        ) : null}
        {isNativeShell ? (
          <>
            <div
              className="pointer-events-auto absolute z-40"
              style={{
                left: `${APP_WINDOW_RESIZE_EDGE}px`,
                top: `${APP_WINDOW_RESIZE_EDGE}px`,
                width: `${LEFT_RAIL_WIDTH - APP_WINDOW_RESIZE_EDGE}px`,
                height: `${44 - APP_WINDOW_RESIZE_EDGE}px`,
                WebkitAppRegion: 'drag' as const,
              }}
              data-tauri-drag-region="true"
              aria-hidden="true"
            />
            {leftWorkspaceWidth > LEFT_RAIL_WIDTH ? (
              <div
                className="pointer-events-auto absolute z-40"
                style={{
                  left: `${LEFT_RAIL_WIDTH}px`,
                  top: `${APP_WINDOW_RESIZE_EDGE}px`,
                  width: `${leftWorkspaceWidth - LEFT_RAIL_WIDTH}px`,
                  height: `${44 - APP_WINDOW_RESIZE_EDGE}px`,
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
            'app-shell-layout-grid relative grid h-full min-w-0 flex-1 gap-0 overflow-hidden box-border transition-[grid-template-columns]',
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
                'app-shell-layout-grid grid h-full min-h-0 min-w-0 transition-[grid-template-columns] duration-300',
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
        {messageDeleteDialog}
        {callOverlay}
        {!isNativeShell ? windowResizeHandles : null}
      </div>
    </div>
  );
}
