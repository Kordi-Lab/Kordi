import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { subscribeNativeLiveResize } from '@/app/nativeLiveResize';
import {
  clampDetailPanelWidth,
  clampSessionPanelWidth,
  clampWindowSize,
  getViewportFillSize,
  getInitialWindowSize,
  getWorkspaceWindowMinWidth,
  LEFT_RAIL_WIDTH,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from '@/kordi-app/layout';
import type { NavId, PanelResizeTarget, ResizeDirection } from '@/kordi-app/types';

type UseAppLayoutStateArgs = {
  activeNav: NavId;
  isNativeShell: boolean;
};

export function useAppLayoutState({ activeNav, isNativeShell }: UseAppLayoutStateArgs) {
  const resizeStateRef = useRef<{
    direction: ResizeDirection;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const panelResizeStateRef = useRef<{
    target: PanelResizeTarget;
    startX: number;
    startWidth: number;
  } | null>(null);
  const settingsContentRef = useRef<HTMLDivElement | null>(null);
  const windowWidthRef = useRef(WINDOW_DEFAULT_WIDTH);
  const leftWorkspaceWidthRef = useRef(LEFT_RAIL_WIDTH);
  const rightDetailVisibleRef = useRef(false);

  const [isSessionPanelCollapsed, setIsSessionPanelCollapsed] = useState(false);
  const [isDetailPanelCollapsed, setIsDetailPanelCollapsed] = useState(
    () => activeNav === 'chats' || activeNav === 'projects',
  );
  const [sessionRailUserWidth, setSessionRailUserWidth] = useState(248);
  const [detailRailUserWidth, setDetailRailUserWidth] = useState(344);
  const [settingsMeasuredWidth, setSettingsMeasuredWidth] = useState<number | null>(null);
  const [isLayoutResizing, setIsLayoutResizing] = useState(false);

  const showSessionRail = activeNav === 'chats' || activeNav === 'projects';
  const showRightDetailRail = activeNav === 'chats' || activeNav === 'projects';
  const showResizableRightDetailRail = activeNav === 'projects';
  const initialMinWindowWidth = Math.max(
    WINDOW_MIN_WIDTH,
    getWorkspaceWindowMinWidth({
      showSessionRail,
      collapseChatSessions: false,
      showRightDetailRail: showResizableRightDetailRail,
      isDetailPanelCollapsed: activeNav === 'chats' || activeNav === 'projects',
    }),
  );
  const [windowSize, setWindowSize] = useState(() =>
    isNativeShell
      ? getViewportFillSize(initialMinWindowWidth, WINDOW_MIN_HEIGHT)
      : getInitialWindowSize({ minWidth: initialMinWindowWidth, minHeight: WINDOW_MIN_HEIGHT }),
  );
  const showChatDetailRail = activeNav === 'chats';
  const collapseChatSessions = showSessionRail && isSessionPanelCollapsed;
  const isSingleWorkspacePage = activeNav !== 'chats' && activeNav !== 'projects';
  const sessionRailWidth =
    showSessionRail && !collapseChatSessions
      ? clampSessionPanelWidth(sessionRailUserWidth, windowSize.width, showResizableRightDetailRail && !isDetailPanelCollapsed)
      : 0;
  const leftWorkspaceWidth =
    collapseChatSessions || isSingleWorkspacePage
      ? LEFT_RAIL_WIDTH
      : LEFT_RAIL_WIDTH + sessionRailWidth;
  const detailRailWidth =
    showResizableRightDetailRail && !isDetailPanelCollapsed
      ? clampDetailPanelWidth(detailRailUserWidth, windowSize.width, leftWorkspaceWidth)
      : 0;
  const minWindowWidth = Math.max(
    WINDOW_MIN_WIDTH,
    getWorkspaceWindowMinWidth({
      showSessionRail,
      collapseChatSessions,
      showRightDetailRail: showResizableRightDetailRail,
      isDetailPanelCollapsed,
    }),
  );
  const settingsRailWidth = Math.max(240, Math.min(272, Math.round(windowSize.width * 0.18)));
  const settingsContentWidth = Math.max(420, windowSize.width - LEFT_RAIL_WIDTH - settingsRailWidth - 48);
  const authSettingsLayoutWidth = Math.max(320, settingsMeasuredWidth ?? settingsContentWidth);

  useEffect(() => {
    windowWidthRef.current = windowSize.width;
    leftWorkspaceWidthRef.current = leftWorkspaceWidth;
    rightDetailVisibleRef.current = showResizableRightDetailRail && !isDetailPanelCollapsed;
  }, [windowSize.width, leftWorkspaceWidth, showResizableRightDetailRail, isDetailPanelCollapsed]);

  useEffect(() => {
    if (!isNativeShell) {
      setWindowSize((current) => clampWindowSize(current.width, current.height, { minWidth: minWindowWidth, minHeight: WINDOW_MIN_HEIGHT }));
      return;
    }

    let cancelled = false;

    void (async () => {
      const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/dpi'),
      ]);
      const currentWindow = getCurrentWindow();

      await currentWindow.setMinSize(new LogicalSize(minWindowWidth, WINDOW_MIN_HEIGHT));

      const nextWidth = Math.max(window.innerWidth, minWindowWidth);
      const nextHeight = Math.max(window.innerHeight, WINDOW_MIN_HEIGHT);

      if (window.innerWidth < minWindowWidth || window.innerHeight < WINDOW_MIN_HEIGHT) {
        await currentWindow.setSize(new LogicalSize(nextWidth, nextHeight));
      }

      if (!cancelled) {
        setWindowSize((current) => (
          current.width === nextWidth && current.height === nextHeight
            ? current
            : { width: nextWidth, height: nextHeight }
        ));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isNativeShell, minWindowWidth]);

  useEffect(() => {
    if (!isNativeShell) return undefined;

    return subscribeNativeLiveResize((state) => {
      if (state.active) return;
      const nextWidth = Math.max(window.innerWidth, minWindowWidth);
      const nextHeight = Math.max(window.innerHeight, WINDOW_MIN_HEIGHT);
      windowWidthRef.current = nextWidth;
      setWindowSize((current) => (
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight }
      ));
    });
  }, [isNativeShell, minWindowWidth]);

  useEffect(() => {
    if (isNativeShell) return undefined;
    const element = settingsContentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const updateWidth = () => {
      const styles = window.getComputedStyle(element);
      const paddingLeft = Number.parseFloat(styles.paddingLeft || '0') || 0;
      const paddingRight = Number.parseFloat(styles.paddingRight || '0') || 0;
      const contentWidth = Math.max(0, element.clientWidth - paddingLeft - paddingRight);
      setSettingsMeasuredWidth((current) => current === contentWidth ? current : contentWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [activeNav, isNativeShell]);

  useEffect(() => {
    const handleWindowResize = () => {
      setWindowSize((current) => clampWindowSize(current.width, current.height, {
        minWidth: minWindowWidth,
        minHeight: WINDOW_MIN_HEIGHT,
      }));
    };

    const handlePointerMove = (event: MouseEvent) => {
      const resizeState = resizeStateRef.current;
      if (resizeState) {
        let nextWidth = resizeState.startWidth;
        let nextHeight = resizeState.startHeight;
        const deltaX = event.clientX - resizeState.startX;
        const deltaY = event.clientY - resizeState.startY;

        if (resizeState.direction === 'right' || resizeState.direction === 'top-right' || resizeState.direction === 'bottom-right') {
          nextWidth = resizeState.startWidth + deltaX;
        }

        if (resizeState.direction === 'left' || resizeState.direction === 'top-left' || resizeState.direction === 'bottom-left') {
          nextWidth = resizeState.startWidth - deltaX;
        }

        if (resizeState.direction === 'bottom' || resizeState.direction === 'bottom-left' || resizeState.direction === 'bottom-right') {
          nextHeight = resizeState.startHeight + deltaY;
        }

        if (resizeState.direction === 'top' || resizeState.direction === 'top-left' || resizeState.direction === 'top-right') {
          nextHeight = resizeState.startHeight - deltaY;
        }

        setWindowSize(clampWindowSize(nextWidth, nextHeight, { minWidth: minWindowWidth, minHeight: WINDOW_MIN_HEIGHT }));
      }

      const panelResizeState = panelResizeStateRef.current;
      if (panelResizeState) {
        const deltaX = event.clientX - panelResizeState.startX;

        if (panelResizeState.target === 'session') {
          setSessionRailUserWidth(
            clampSessionPanelWidth(
              panelResizeState.startWidth + deltaX,
              windowWidthRef.current,
              rightDetailVisibleRef.current,
            ),
          );
        }

        if (panelResizeState.target === 'detail') {
          setDetailRailUserWidth(clampDetailPanelWidth(panelResizeState.startWidth - deltaX, windowWidthRef.current, leftWorkspaceWidthRef.current));
        }
      }
    };

    const stopResize = () => {
      const hadWindowResize = Boolean(resizeStateRef.current);
      const hadPanelResize = Boolean(panelResizeStateRef.current);
      if (!hadWindowResize && !hadPanelResize) return;

      resizeStateRef.current = null;
      panelResizeStateRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setIsLayoutResizing(false);
    };

    if (!isNativeShell) window.addEventListener('resize', handleWindowResize);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', stopResize);

    return () => {
      if (!isNativeShell) window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', stopResize);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isNativeShell, minWindowWidth]);

  const startWindowResize =
    (direction: ResizeDirection) => (event: ReactMouseEvent<HTMLDivElement | HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        direction,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: windowSize.width,
        startHeight: windowSize.height,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor =
        direction === 'left' || direction === 'right'
          ? 'ew-resize'
          : direction === 'top' || direction === 'bottom'
            ? 'ns-resize'
            : direction === 'top-left' || direction === 'bottom-right'
              ? 'nwse-resize'
              : 'nesw-resize';
      setIsLayoutResizing(true);
    };

  const startPanelResize =
    (target: PanelResizeTarget) => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isNativeShell) {
        const liveWindowWidth = Math.max(window.innerWidth, minWindowWidth);
        windowWidthRef.current = liveWindowWidth;
        setWindowSize((current) => (
          current.width === liveWindowWidth
            ? current
            : { width: liveWindowWidth, height: current.height }
        ));
      }
      panelResizeStateRef.current = {
        target,
        startX: event.clientX,
        startWidth: target === 'session' ? sessionRailWidth : detailRailWidth,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
      setIsLayoutResizing(true);
    };

  return {
    settingsContentRef,
    isSessionPanelCollapsed,
    setIsSessionPanelCollapsed,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    windowSize,
    sessionRailWidth,
    detailRailWidth,
    settingsRailWidth,
    settingsContentWidth,
    authSettingsLayoutWidth,
    isLayoutResizing,
    showSessionRail,
    showRightDetailRail,
    showChatDetailRail,
    collapseChatSessions,
    isSingleWorkspacePage,
    leftWorkspaceWidth,
    startWindowResize,
    startPanelResize,
  };
}
