export const LEFT_RAIL_WIDTH = 72;
export const WINDOW_MIN_WIDTH = 980;
export const WINDOW_MIN_HEIGHT = 680;
export const WINDOW_DEFAULT_WIDTH = 1460;
export const WINDOW_DEFAULT_HEIGHT = 900;
export const SESSION_PANEL_MIN_WIDTH = 220;
export const MAIN_CONTENT_MIN_WIDTH = 600;
export const DETAIL_PANEL_MIN_WIDTH = 300;
export const DETAIL_PANEL_MAX_WIDTH = 1040;

type ViewportBoundsOptions = {
  minWidth?: number;
  minHeight?: number;
};

type WorkspaceWindowMinWidthArgs = {
  showSessionRail: boolean;
  collapseChatSessions: boolean;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
};

export function getWorkspaceWindowMinWidth({
  showSessionRail,
  collapseChatSessions,
  showRightDetailRail,
  isDetailPanelCollapsed,
}: WorkspaceWindowMinWidthArgs) {
  return (
    LEFT_RAIL_WIDTH
    + (showSessionRail && !collapseChatSessions ? SESSION_PANEL_MIN_WIDTH : 0)
    + MAIN_CONTENT_MIN_WIDTH
    + (showRightDetailRail && !isDetailPanelCollapsed ? DETAIL_PANEL_MIN_WIDTH : 0)
  );
}

export function getViewportWindowBounds({
  minWidth = WINDOW_MIN_WIDTH,
  minHeight = WINDOW_MIN_HEIGHT,
}: ViewportBoundsOptions = {}) {
  if (typeof window === 'undefined') {
    return {
      minWidth,
      maxWidth: WINDOW_DEFAULT_WIDTH,
      minHeight,
      maxHeight: WINDOW_DEFAULT_HEIGHT,
    };
  }

  const maxWidth = Math.max(760, window.innerWidth - 32);
  const maxHeight = Math.max(560, window.innerHeight - 32);

  return {
    minWidth: Math.min(minWidth, maxWidth),
    maxWidth,
    minHeight: Math.min(minHeight, maxHeight),
    maxHeight,
  };
}

export function clampWindowSize(width: number, height: number, options: ViewportBoundsOptions = {}) {
  const bounds = getViewportWindowBounds(options);

  return {
    width: Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth),
    height: Math.min(Math.max(height, bounds.minHeight), bounds.maxHeight),
  };
}

export function getInitialWindowSize(options: ViewportBoundsOptions = {}) {
  const bounds = getViewportWindowBounds(options);

  return {
    width: Math.min(WINDOW_DEFAULT_WIDTH, bounds.maxWidth),
    height: Math.min(WINDOW_DEFAULT_HEIGHT, bounds.maxHeight),
  };
}

export function getViewportFillSize(minWidth = WINDOW_MIN_WIDTH, minHeight = WINDOW_MIN_HEIGHT) {
  if (typeof window === 'undefined') {
    return {
      width: WINDOW_DEFAULT_WIDTH,
      height: WINDOW_DEFAULT_HEIGHT,
    };
  }

  return {
    width: Math.max(minWidth, window.innerWidth),
    height: Math.max(minHeight, window.innerHeight),
  };
}

export function clampSessionPanelWidth(width: number, windowWidth: number, rightPanelVisible: boolean) {
  const reservedRightPanel = rightPanelVisible ? DETAIL_PANEL_MIN_WIDTH : 0;
  const maxWidth = Math.max(SESSION_PANEL_MIN_WIDTH, windowWidth - LEFT_RAIL_WIDTH - reservedRightPanel - MAIN_CONTENT_MIN_WIDTH);
  return Math.min(Math.max(width, SESSION_PANEL_MIN_WIDTH), maxWidth);
}

export function clampDetailPanelWidth(width: number, windowWidth: number, leftWidth: number) {
  const maxWidth = Math.max(DETAIL_PANEL_MIN_WIDTH, Math.min(DETAIL_PANEL_MAX_WIDTH, windowWidth - leftWidth - MAIN_CONTENT_MIN_WIDTH));
  return Math.min(Math.max(width, DETAIL_PANEL_MIN_WIDTH), maxWidth);
}
