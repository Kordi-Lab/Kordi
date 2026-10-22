import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import { CARD_DESIGNS, COLOUR_DESIGNS, type CgCardDesign, type CgCardIcon } from './cardDesign';
import { CARD_ICONS } from './cardLook';
import { CardGlyph } from './ProfileCard';
import { CG_CARD_ICONS, type CgProfileKind } from './types';

const iconLabel = (icon: CgCardIcon) => `${icon[0].toUpperCase()}${icon.slice(1)}`;

/** Every background as a plain colour: the six kind designs (which keep their patterns on the card), then ten colours. */
const BACKGROUNDS: Array<{ design: CgCardDesign; label: string }> = [...CARD_DESIGNS, ...COLOUR_DESIGNS];

/**
 * The card's look, about 300px wide under its icon square: sixteen round colour swatches and
 * eighteen icons, the current ones ringed. A click applies at once; the current icon again goes
 * back to the background's own glyph.
 */
export function CardLookPopover({ design, icon, onDesign, onIcon, onClose, className }: {
  design: CgCardDesign;
  icon: CgCardIcon | null;
  onDesign: (design: CgCardDesign) => void;
  onIcon: (icon: CgCardIcon | null) => void;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !ref.current?.contains(target) && !(target instanceof Element && target.closest('[data-cg-look]'))) onClose();
    };
    // Capture, so Escape closes the popover before a dialog behind it sees the key.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={cn('cg-pop cg-look', className)} role="dialog" aria-label="Card look">
      <div className="cg-pop-label is-first">Background</div>
      <div className="cg-look-colours" role="radiogroup" aria-label="Background">
        {BACKGROUNDS.map((entry) => (
          <button
            key={entry.design}
            type="button"
            role="radio"
            aria-checked={entry.design === design}
            aria-label={entry.label}
            title={entry.label}
            data-design={entry.design}
            className={cn('cg-look-colour', entry.design === design && 'is-on')}
            onClick={() => onDesign(entry.design)}
          />
        ))}
      </div>
      <div className="cg-pop-label">Icon</div>
      <div className="cg-look-icons" role="radiogroup" aria-label="Icon">
        {CG_CARD_ICONS.map((name) => {
          const Icon = CARD_ICONS[name];
          const on = name === icon;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={iconLabel(name)}
              title={iconLabel(name)}
              data-design={on ? design : undefined}
              className={cn('cg-look-icon', on && 'is-on')}
              onClick={() => onIcon(on ? null : name)}
            >
              <Icon aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The tinted icon square as a button that opens the look popover. */
export function CardLookButton({ design, icon, kind, className, open, onToggle }: {
  design: CgCardDesign;
  icon: CgCardIcon | null;
  kind: CgProfileKind;
  className: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(className, 'is-look')}
      data-design={design}
      data-cg-look="true"
      aria-label="Background and icon"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Background and icon"
      onClick={onToggle}
    >
      <CardGlyph design={design} icon={icon} kind={kind} />
    </button>
  );
}
