export const LEFT_RAIL_WIDTH = 78;
export const WINDOW_MIN_WIDTH = 980;
export const WINDOW_MIN_HEIGHT = 680;
export const WINDOW_DEFAULT_WIDTH = 1460;
export const WINDOW_DEFAULT_HEIGHT = 900;
export const DETAIL_PANEL_MIN_WIDTH = 300;
export const DETAIL_PANEL_MAX_WIDTH = 420;

export function getViewportWindowBounds() {
  if (typeof window === 'undefined') {
    return {
      minWidth: WINDOW_MIN_WIDTH,
      maxWidth: WINDOW_DEFAULT_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      maxHeight: WINDOW_DEFAULT_HEIGHT,
    };
  }

  const maxWidth = Math.max(760, window.innerWidth - 32);
  const maxHeight = Math.max(560, window.innerHeight - 32);

  return {
    minWidth: Math.min(WINDOW_MIN_WIDTH, maxWidth),
    maxWidth,
    minHeight: Math.min(WINDOW_MIN_HEIGHT, maxHeight),
    maxHeight,
  };
}

export function clampWindowSize(width: number, height: number) {
  const bounds = getViewportWindowBounds();

  return {
    width: Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth),
    height: Math.min(Math.max(height, bounds.minHeight), bounds.maxHeight),
  };
}

export function getInitialWindowSize() {
  const bounds = getViewportWindowBounds();

  return {
    width: Math.min(WINDOW_DEFAULT_WIDTH, bounds.maxWidth),
    height: Math.min(WINDOW_DEFAULT_HEIGHT, bounds.maxHeight),
  };
}

export function getViewportFillSize() {
  if (typeof window === 'undefined') {
    return {
      width: WINDOW_DEFAULT_WIDTH,
      height: WINDOW_DEFAULT_HEIGHT,
    };
  }

  return {
    width: Math.max(WINDOW_MIN_WIDTH, window.innerWidth),
    height: Math.max(WINDOW_MIN_HEIGHT, window.innerHeight),
  };
}

export function clampSessionPanelWidth(width: number, windowWidth: number, rightPanelVisible: boolean) {
  const reservedRightPanel = rightPanelVisible ? 200 : 0;
  const maxWidth = Math.max(220, windowWidth - LEFT_RAIL_WIDTH - reservedRightPanel - 420);
  return Math.min(Math.max(width, 220), maxWidth);
}

export function clampDetailPanelWidth(width: number, windowWidth: number, leftWidth: number) {
  const maxWidth = Math.max(DETAIL_PANEL_MIN_WIDTH, Math.min(DETAIL_PANEL_MAX_WIDTH, windowWidth - leftWidth - 420));
  return Math.min(Math.max(width, DETAIL_PANEL_MIN_WIDTH), maxWidth);
}
