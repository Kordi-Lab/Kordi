import { getCurrentWindow } from '@tauri-apps/api/window';
import { useMemo, useState, type MouseEventHandler, type ReactNode } from 'react';
import { NativeChatTitlebarContext } from '@/app/nativeChatTitlebarContext';

import {
  nativeWindowResizeDirection,
  shouldStartNativeWindowDrag,
} from '@/app/windowDrag';
import { NativeTitlebar, type NativeTitlebarActions } from '@/app/NativeTitlebar';
import { useNativeBackdrop } from '@/app/useNativeBackdrop';
import { cn } from '@/lib/utils';

type AppShellFrameProps = NativeTitlebarActions & {
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
  windowTitle,
  onToggleSessionPanel,
  onToggleDetailPanel,
}: AppShellFrameProps) {
  const rootRef = useNativeBackdrop(isNativeShell, rootThemeClass, leftWorkspaceWidth);
  const instanceLabel = previewInstanceLabel();
  const [titleHost, setTitleHost] = useState<HTMLDivElement | null>(null);
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const chatTitlebar = useMemo(() => isNativeShell
    ? { title: titleHost, actions: actionsHost }
    : null, [isNativeShell, titleHost, actionsHost]);
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
      ref={rootRef}
      className={cn(
        'kordi-app app-page-bg w-full min-w-0 max-w-full text-[13px] text-foreground',
        rootThemeClass,
        isNativeShell ? 'app-native-viewport overflow-hidden p-0' : 'min-h-screen p-4 md:p-6',
      )}
    >
      <div
        className={cn(
          'app-shell relative flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden',
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
        {instanceLabel && !isNativeShell ? (
          <div className="app-preview-instance-label" aria-label={`Preview instance: ${instanceLabel}`}>
            Preview · {instanceLabel}
          </div>
        ) : null}
        {isNativeShell ? (
          <NativeTitlebar
            titleHostRef={setTitleHost}
            actionsHostRef={setActionsHost}
            windowTitle={windowTitle}
            leftWorkspaceWidth={leftWorkspaceWidth}
            collapseChatSessions={collapseChatSessions}
            isDetailPanelCollapsed={isDetailPanelCollapsed}
            onToggleSessionPanel={onToggleSessionPanel}
            onToggleDetailPanel={showRightDetailRail ? onToggleDetailPanel : undefined}
          />
        ) : null}
        <div
          className={cn(
            'app-shell-layout-grid relative grid min-h-0 min-w-0 flex-1 gap-0 overflow-hidden box-border transition-[grid-template-columns]',
          )}
          style={{
            gridTemplateColumns: `${leftWorkspaceWidth}px minmax(0, 1fr)`,
            gridTemplateRows: 'minmax(0, 1fr)',
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
              'app-shell-content relative min-h-0 min-w-0 overflow-hidden',
              isSingleWorkspacePage ? 'app-main-panel rounded-none border-0' : 'app-main-panel rounded-br-[22px] rounded-l-none border-l border-white/10',
            )}
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            <div
              className={cn(
                'app-shell-layout-grid grid min-h-0 min-w-0 transition-[grid-template-columns] duration-300',
              )}
              style={{
                gridTemplateColumns: showRightDetailRail && !isDetailPanelCollapsed ? `minmax(0, 1fr) ${detailRailWidth}px` : 'minmax(0, 1fr)',
                gridTemplateRows: 'minmax(0, 1fr)',
              }}
            >
              <main className="flex min-h-0 min-w-0 overflow-hidden">
                <NativeChatTitlebarContext value={chatTitlebar}>
                  {mainContent}
                </NativeChatTitlebarContext>
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
