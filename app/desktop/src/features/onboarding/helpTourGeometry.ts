export type TourRect = { left: number; top: number; width: number; height: number };

/** Keep the coachmark beside its target and inside the visible viewport. */
export function helpTourGeometry(target: TourRect | null, viewport: { width: number; height: number }, panel: { width: number; height: number }) {
  const margin = 12;
  const gap = 18;
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, Math.max(margin, max)));
  if (!target) return { left: clamp(64, viewport.width - panel.width - margin), top: clamp(viewport.height - panel.height - 20, viewport.height - panel.height - margin), side: 'none', arrow: 0 };
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  const side = right + gap + panel.width <= viewport.width - margin ? 'right'
    : target.left - gap - panel.width >= margin ? 'left'
      : bottom + gap + panel.height <= viewport.height - margin ? 'bottom' : 'top';
  const left = clamp(side === 'right' ? right + gap : side === 'left' ? target.left - gap - panel.width : target.left + target.width / 2 - panel.width / 2, viewport.width - panel.width - margin);
  const top = clamp(side === 'bottom' ? bottom + gap : side === 'top' ? target.top - gap - panel.height : target.top + target.height / 2 - panel.height / 2, viewport.height - panel.height - margin);
  const vertical = side === 'left' || side === 'right';
  const arrow = Math.max(20, Math.min(vertical ? target.top + target.height / 2 - top : target.left + target.width / 2 - left, (vertical ? panel.height : panel.width) - 20));
  return { left, top, side, arrow };
}
