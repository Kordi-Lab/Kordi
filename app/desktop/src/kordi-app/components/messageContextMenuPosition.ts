type MessageContextMenuPositionInput = {
  clientX: number;
  clientY: number;
  targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
};

export function messageContextMenuPosition({
  clientX,
  targetRect,
  viewportWidth,
  viewportHeight,
  menuWidth = 216,
  menuHeight = 312,
}: MessageContextMenuPositionInput) {
  const gap = 2;
  const aboveOverlap = 24;
  const anchorX = clientX <= (targetRect.left + targetRect.right) / 2
    ? targetRect.left
    : targetRect.right - menuWidth;
  const belowY = targetRect.bottom + gap;
  const aboveY = targetRect.top - menuHeight + aboveOverlap;
  const y = belowY + menuHeight <= viewportHeight - 8 ? belowY : aboveY;
  return {
    x: Math.max(8, Math.min(anchorX, viewportWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - menuHeight - 8)),
  };
}
