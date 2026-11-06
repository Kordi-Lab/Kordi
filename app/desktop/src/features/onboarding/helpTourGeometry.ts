export type TourRect = { left: number; top: number; width: number; height: number };
type Side = 'right' | 'bottom' | 'left' | 'top';

/** Keep the coachmark beside its target and inside the visible viewport. */
export function helpTourGeometry(target: TourRect | null, viewport: { width: number; height: number }, panel: { width: number; height: number }) {
  const margin = 12;
  const gap = 16;
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, Math.max(margin, max)));
  if (!target) return { left: clamp(64, viewport.width - panel.width - margin), top: clamp(viewport.height - panel.height - 20, viewport.height - panel.height - margin), side: 'none', arrow: 0 };
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  // Space left over on each side once the panel sits there. Take the first side that fits, in reading
  // order, so the panel lands in open space next to the target instead of across the window; when
  // none fits, take the roomiest side and let the clamp keep the panel on screen.
  const spare: Record<Side, number> = {
    right: viewport.width - margin - right - gap - panel.width,
    bottom: viewport.height - margin - bottom - gap - panel.height,
    left: target.left - gap - margin - panel.width,
    top: target.top - gap - margin - panel.height,
  };
  const sides: readonly Side[] = ['right', 'bottom', 'left', 'top'];
  const side = sides.find((name) => spare[name] >= 0) ?? [...sides].sort((a, b) => spare[b] - spare[a])[0];
  const vertical = side === 'left' || side === 'right';
  // A wide or tall target anchors the panel at its start edge, not at a far-away center.
  const wide = !vertical && target.width > panel.width * 1.4;
  const tall = vertical && target.height > panel.height * 1.4;
  const left = clamp(side === 'right' ? right + gap : side === 'left' ? target.left - gap - panel.width
    : wide ? target.left : target.left + target.width / 2 - panel.width / 2, viewport.width - panel.width - margin);
  const top = clamp(side === 'bottom' ? bottom + gap : side === 'top' ? target.top - gap - panel.height
    : tall ? target.top : target.top + target.height / 2 - panel.height / 2, viewport.height - panel.height - margin);
  const aim = vertical
    ? (tall ? target.top + 28 : target.top + target.height / 2) - top
    : (wide ? target.left + 40 : target.left + target.width / 2) - left;
  const arrow = Math.max(20, Math.min(aim, (vertical ? panel.height : panel.width) - 20));
  return { left, top, side, arrow };
}
