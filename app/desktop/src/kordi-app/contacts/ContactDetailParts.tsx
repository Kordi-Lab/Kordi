import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, MoreHorizontal, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Centered avatar, name, and one quiet line, like a messaging-app profile. */
export function DetailHeader({
  avatar,
  name,
  line,
  lineAccent = false,
}: {
  avatar: ReactNode;
  name: string;
  line?: string;
  lineAccent?: boolean;
}) {
  return (
    <div className="app-contacts-detail-header flex flex-col items-center text-center">
      {avatar}
      <h2 className="mt-3 max-w-full truncate text-[19px] font-semibold leading-7 tracking-[-0.01em]">{name}</h2>
      {line ? (
        <div className={cn('app-contacts-detail-presence max-w-full truncate text-[13px] leading-5', lineAccent ? 'app-contacts-presence-online' : 'app-contacts-muted')}>
          {line}
        </div>
      ) : null}
    </div>
  );
}

/** Equal-width row of action tiles under the header. */
export function DetailTiles({ children }: { children: ReactNode }) {
  return <div className="app-contacts-tiles mt-6 grid grid-flow-col auto-cols-fr gap-2">{children}</div>;
}

export function DetailTile({
  icon,
  label,
  onClick,
  disabled,
  tone = 'default',
  ariaLabel,
  ariaHasPopup,
  ariaExpanded,
}: {
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  ariaLabel?: string;
  ariaHasPopup?: 'menu';
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      className={cn(
        'app-contacts-tile inline-flex h-[62px] w-full flex-col items-center justify-center gap-1 rounded-[12px] px-2 text-[12.5px] font-medium leading-4 disabled:pointer-events-none disabled:opacity-50',
        tone === 'primary' && 'is-primary',
        tone === 'danger' && 'is-danger',
      )}
    >
      {icon}
      <span className="inline-flex items-center gap-1">{label}</span>
    </button>
  );
}

/** "More" tile with the overflow menu; today it only holds Delete contact. */
export function MoreTile({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="app-contacts-tile-slot relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
        }
      }}
    >
      <DetailTile
        icon={<MoreHorizontal className="h-5 w-5" aria-hidden="true" />}
        label="More"
        ariaLabel="More actions"
        ariaHasPopup="menu"
        ariaExpanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <div role="menu" className="app-contacts-menu absolute right-0 top-[68px] z-10 min-w-[168px] rounded-[10px] p-1">
          <button
            type="button"
            role="menuitem"
            className="app-contacts-danger-action flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px]"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete contact
          </button>
        </div>
      ) : null}
    </div>
  );
}

export type InfoCardRow = {
  key: string;
  value: ReactNode;
  caption: string;
  accent?: boolean;
  trailing?: ReactNode;
};

/** Grouped card of value-over-caption rows. */
export function InfoCard({ rows }: { rows: InfoCardRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="app-contacts-card mt-5 rounded-[12px]">
      {rows.map((row) => (
        <div key={row.key} className="app-contacts-card-row flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className={cn('app-contacts-card-value break-words text-[14px] leading-5', row.accent && 'is-accent')}>{row.value}</div>
            <div className="app-contacts-muted text-[12px] leading-4">{row.caption}</div>
          </div>
          {row.trailing}
        </div>
      ))}
    </div>
  );
}

/** Copies a value to the clipboard and briefly confirms with a check mark. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
      className="app-contacts-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
