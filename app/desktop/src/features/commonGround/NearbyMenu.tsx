import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { NbMenuItem } from './nearbyFormat';
import { usePopoverDismiss } from './usePopoverDismiss';

/** The small row menu the app uses: a list under its button, with ticks when it picks one value. */
function NbMenu({ items, anchor, align, label, onClose }: { items: NbMenuItem[]; anchor: string; align: 'left' | 'right'; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, anchor, onClose);
  const checks = items.some((item) => item.checked !== undefined);
  return (
    <div ref={ref} className={cn('cg-nb-menu', align === 'right' && 'is-right')} role="menu" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role={checks ? 'menuitemradio' : 'menuitem'}
          aria-checked={checks ? Boolean(item.checked) : undefined}
          className={cn('cg-nb-mitem', item.danger && 'is-danger', item.separated && 'is-separated')}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {checks ? <span className="cg-nb-tick" aria-hidden="true">{item.checked ? <Check className="h-[13px] w-[13px]" /> : null}</span> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A button that opens a menu below it; `label` names the menu, and the button when it shows only an icon. */
export function NbMenuButton({ id, label, iconOnly = false, className, items, align = 'left', disabled, children }: {
  id: string;
  label: string;
  iconOnly?: boolean;
  className: string;
  items: NbMenuItem[];
  align?: 'left' | 'right';
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="cg-nb-anchor">
      <button
        type="button"
        className={className}
        data-cg-nb-menu={id}
        aria-label={iconOnly ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      {open ? <NbMenu items={items} anchor={`[data-cg-nb-menu="${id}"]`} align={align} label={label} onClose={close} /> : null}
    </span>
  );
}
