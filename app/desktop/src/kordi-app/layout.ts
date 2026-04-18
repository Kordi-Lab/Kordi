export const WINDOW_MIN_WIDTH = 980;
export const WINDOW_MIN_HEIGHT = 680;
export const WINDOW_DEFAULT_WIDTH = 1460;
export const WINDOW_DEFAULT_HEIGHT = 900;

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

export function clampSessionPanelWidth(width: number, windowWidth: number, rightPanelVisible: boolean) {
  const reservedRightPanel = rightPanelVisible ? 220 : 0;
  const maxWidth = Math.max(220, windowWidth - 64 - reservedRightPanel - 360);
  return Math.min(Math.max(width, 220), maxWidth);
}

export function clampDetailPanelWidth(width: number, windowWidth: number, leftWidth: number) {
  const maxWidth = Math.max(220, Math.min(420, windowWidth - leftWidth - 360));
  return Math.min(Math.max(width, 220), maxWidth);
}
