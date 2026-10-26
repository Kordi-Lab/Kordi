import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, Pencil, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BlueprintMenuOption<T extends string> = { value: T; label: string; description?: string };

/** A Blueprint row whose value is picked from a small menu (Access, Cooperative, Proactive). */
export function BlueprintMenuRow<T extends string>({
  icon: Icon,
  label,
  menuLabel,
  value,
  detail,
  options,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  menuLabel: string;
  value: T;
  detail: string;
  options: ReadonlyArray<BlueprintMenuOption<T>>;
  /** Omitted when the row is read-only. */
  onSelect?: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    controlRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    items[currentIndex < 0 ? 0 : (currentIndex + direction + items.length) % items.length]?.focus();
  };

  return (
    <div className="app-agent-studio-blueprint-row">
      <div className="app-agent-studio-blueprint-label"><Icon className="h-4 w-4" />{label}</div>
      <div className="min-w-0">
        <div className="app-agent-studio-blueprint-value">{current?.label}</div>
        <div className="app-agent-studio-blueprint-detail">{detail}</div>
      </div>
      {onSelect ? (
        <div className="app-agent-studio-access-control" ref={controlRef}>
          <button ref={triggerRef} type="button" className="app-button-quiet app-agent-studio-icon-button is-inline-edit app-agent-studio-access-edit" aria-label={`Edit ${label.toLowerCase()}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((next) => !next)}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
          {open ? (
            <div className="app-agent-studio-access-menu" role="menu" aria-label={menuLabel} onKeyDown={handleMenuKeyDown}>
              {options.map((option) => {
                const selected = option.value === value;
                return (
                  <button key={option.value} type="button" role="menuitemradio" aria-checked={selected} className={cn(selected && 'is-selected')} onClick={() => { onSelect(option.value); setOpen(false); triggerRef.current?.focus(); }}>
                    <span className="app-agent-studio-access-menu-check" aria-hidden="true">{selected ? <Check className="h-3.5 w-3.5" /> : null}</span>
                    {option.description ? (
                      <span className="app-agent-studio-access-menu-option"><span>{option.label}</span><small>{option.description}</small></span>
                    ) : <span>{option.label}</span>}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : <span />}
    </div>
  );
}
