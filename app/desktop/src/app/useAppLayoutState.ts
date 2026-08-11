import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

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
import { createLayoutResizeScheduler } from '@/app/layoutResizeScheduler';

type UseAppLayoutStateArgs = {
  activeNav: NavId;
  isNativeShell: boolean;
};

function readElementContentWidth(element: HTMLDivElement) {
  const styles = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(styles.paddingLeft || '0') || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight || '0') || 0;
  return Math.max(0, element.clientWidth - paddingLeft - paddingRight);
}

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
  const windowSizeRef = useRef({ width: WINDOW_DEFAULT_WIDTH, height: WINDOW_MIN_HEIGHT });
  const pendingSettingsMeasuredWidthRef = useRef<number | null>(null);
  const nativeWindowResizingRef = useRef(false);
  const windowWidthRef = useRef(WINDOW_DEFAULT_WIDTH);
  const leftWorkspaceWidthRef = useRef(LEFT_RAIL_WIDTH);
  const sessionRailWidthRef = useRef(248);
  const detailRailWidthRef = useRef(344);
  const minWindowWidthRef = useRef(WINDOW_MIN_WIDTH);
  const rightDetailVisibleRef = useRef(false);

  const [isSessionPanelCollapsed, setIsSessionPanelCollapsed] = useState(false);
  const [isDetailPanelCollapsed, setIsDetailPanelCollapsed] = useState(
    () => activeNav === 'chats' || activeNav === 'projects',
  );
  const [sessionRailUserWidth, setSessionRailUserWidth] = useState(248);
  const [detailRailUserWidth, setDetailRailUserWidth] = useState(344);
  const [settingsMeasuredWidth, setSettingsMeasuredWidth] = useState<number | null>(null);
  const [isPointerLayoutResizing, setIsPointerLayoutResizing] = useState(false);
  const [isNativeWindowResizing, setIsNativeWindowResizing] = useState(false);

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
  const isLayoutResizing = isPointerLayoutResizing || isNativeWindowResizing;

  useEffect(() => {
    if (!isNativeShell) {
      nativeWindowResizingRef.current = false;
      document.documentElement.classList.remove('kordi-native-window-resizing');
      return;
    }
    if (isNativeWindowResizing) {
      document.documentElement.classList.add('kordi-native-window-resizing');
      return;
    }
    nativeWindowResizingRef.current = false;
    document.documentElement.classList.remove('kordi-native-window-resizing');
  }, [isNativeShell, isNativeWindowResizing]);

  useEffect(() => {
    windowSizeRef.current = windowSize;
    windowWidthRef.current = windowSize.width;
    leftWorkspaceWidthRef.current = leftWorkspaceWidth;
    sessionRailWidthRef.current = sessionRailWidth;
    detailRailWidthRef.current = detailRailWidth;
    minWindowWidthRef.current = minWindowWidth;
    rightDetailVisibleRef.current = showResizableRightDetailRail && !isDetailPanelCollapsed;
  }, [detailRailWidth, isDetailPanelCollapsed, leftWorkspaceWidth, minWindowWidth, sessionRailWidth, showResizableRightDetailRail, windowSize]);

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
    const element = settingsContentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const updateWidth = () => {
      const contentWidth = readElementContentWidth(element);
      if (isNativeShell && nativeWindowResizingRef.current) {
        pendingSettingsMeasuredWidthRef.current = contentWidth;
        return;
      }
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
    let disposed = false;
    let releaseFrameHandle: number | null = null;
    let releasePaintHandle: number | null = null;

    const cancelResizeRelease = () => {
      if (releaseFrameHandle !== null) window.cancelAnimationFrame(releaseFrameHandle);
      if (releasePaintHandle !== null) window.cancelAnimationFrame(releasePaintHandle);
      releaseFrameHandle = null;
      releasePaintHandle = null;
    };

    const markNativeResizeStart = () => {
      cancelResizeRelease();
      nativeWindowResizingRef.current = true;
      document.documentElement.classList.add('kordi-native-window-resizing');
      setIsNativeWindowResizing(true);
    };

    const syncNativeWindowSize = () => {
      if (disposed) return;
      const next = getViewportFillSize(minWindowWidthRef.current, WINDOW_MIN_HEIGHT);
      const current = windowSizeRef.current;
      if (current.width === next.width) return;
      const nextWindowSize = { width: next.width, height: current.height };
      windowSizeRef.current = nextWindowSize;
      windowWidthRef.current = next.width;
      setWindowSize(nextWindowSize);
    };

    const finishNativeWindowResize = () => {
      if (disposed) return;
      syncNativeWindowSize();
      releaseFrameHandle = window.requestAnimationFrame(() => {
        releaseFrameHandle = null;
        releasePaintHandle = window.requestAnimationFrame(() => {
          releasePaintHandle = null;
          if (disposed) return;
          const settingsWidth = pendingSettingsMeasuredWidthRef.current
            ?? (settingsContentRef.current ? readElementContentWidth(settingsContentRef.current) : null);
          pendingSettingsMeasuredWidthRef.current = null;
          if (settingsWidth !== null) {
            setSettingsMeasuredWidth((current) => current === settingsWidth ? current : settingsWidth);
          }
          setIsNativeWindowResizing(false);
        });
      });
    };

    const nativeResizeScheduler = isNativeShell
      ? createLayoutResizeScheduler({
          onResizeStart: markNativeResizeStart,
          onResizeFrame: syncNativeWindowSize,
          onResizeEnd: finishNativeWindowResize,
          scheduleFrame: (callback) => window.requestAnimationFrame(callback),
          cancelFrame: (handle) => window.cancelAnimationFrame(handle),
          scheduleTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
          cancelTimeout: (handle) => window.clearTimeout(handle),
        })
      : null;

    const handleWindowResize = () => {
      if (nativeResizeScheduler) {
        nativeResizeScheduler.notifyResize();
        return;
      }
      setWindowSize((current) => {
        const next = clampWindowSize(current.width, current.height, {
          minWidth: minWindowWidthRef.current,
          minHeight: WINDOW_MIN_HEIGHT,
        });
        return current.width === next.width && current.height === next.height ? current : next;
      });
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

        const next = clampWindowSize(nextWidth, nextHeight, {
          minWidth: minWindowWidthRef.current,
          minHeight: WINDOW_MIN_HEIGHT,
        });
        setWindowSize((current) => (
          current.width === next.width && current.height === next.height ? current : next
        ));
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
      setIsPointerLayoutResizing(false);
    };

    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', stopResize);

    return () => {
      disposed = true;
      nativeResizeScheduler?.dispose();
      cancelResizeRelease();
      pendingSettingsMeasuredWidthRef.current = null;
      nativeWindowResizingRef.current = false;
      document.documentElement.classList.remove('kordi-native-window-resizing');
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', stopResize);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isNativeShell]);

  const handleWindowResizeStart = useCallback((
    direction: ResizeDirection,
    event: ReactMouseEvent<HTMLDivElement | HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const currentWindowSize = windowSizeRef.current;
    resizeStateRef.current = {
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: currentWindowSize.width,
      startHeight: currentWindowSize.height,
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
    setIsPointerLayoutResizing(true);
  }, []);
  const windowResizeHandlers = useMemo(() => ({
    left: (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('left', event),
    right: (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('right', event),
    top: (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('top', event),
    bottom: (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('bottom', event),
    'top-left': (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('top-left', event),
    'top-right': (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('top-right', event),
    'bottom-left': (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('bottom-left', event),
    'bottom-right': (event: ReactMouseEvent<HTMLDivElement>) => handleWindowResizeStart('bottom-right', event),
  } satisfies Record<ResizeDirection, (event: ReactMouseEvent<HTMLDivElement>) => void>), [handleWindowResizeStart]);
  const startWindowResize = useCallback(
    (direction: ResizeDirection) => windowResizeHandlers[direction],
    [windowResizeHandlers],
  );

  const handlePanelResizeStart = useCallback((
    target: PanelResizeTarget,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    panelResizeStateRef.current = {
      target,
      startX: event.clientX,
      startWidth: target === 'session' ? sessionRailWidthRef.current : detailRailWidthRef.current,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    setIsPointerLayoutResizing(true);
  }, []);
  const panelResizeHandlers = useMemo(() => ({
    session: (event: ReactMouseEvent<HTMLDivElement>) => handlePanelResizeStart('session', event),
    detail: (event: ReactMouseEvent<HTMLDivElement>) => handlePanelResizeStart('detail', event),
  } satisfies Record<PanelResizeTarget, (event: ReactMouseEvent<HTMLDivElement>) => void>), [handlePanelResizeStart]);
  const startPanelResize = useCallback(
    (target: PanelResizeTarget) => panelResizeHandlers[target],
    [panelResizeHandlers],
  );

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
