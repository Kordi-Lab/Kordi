import type { ReactNode } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useCopyValue } from './contactProfileHooks';

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
  ariaHasPopup?: 'menu' | 'dialog';
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

export type InfoCardRow = {
  key: string;
  value: ReactNode;
  caption: string;
  accent?: boolean;
  trailing?: ReactNode;
  /** Small avatar before the text, for rows that name an account. */
  lead?: ReactNode;
  /** Makes the whole row a button with a trailing chevron. */
  onClick?: () => void;
};

/** Grouped card of value-over-caption rows. */
export function InfoCard({ rows }: { rows: InfoCardRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="app-contacts-card mt-5 rounded-[12px]">
      {rows.map((row) => {
        const content = (
          <>
            {row.lead}
            <div className="min-w-0 flex-1">
              <div className={cn('app-contacts-card-value break-words text-[14px] leading-5', row.accent && 'is-accent')}>{row.value}</div>
              <div className="app-contacts-muted text-[12px] leading-4">{row.caption}</div>
            </div>
            {row.trailing}
            {row.onClick ? <ChevronRight className="app-contacts-chevron h-[15px] w-[15px] shrink-0" aria-hidden="true" /> : null}
          </>
        );
        return row.onClick ? (
          <button
            key={row.key}
            type="button"
            className="app-contacts-card-row app-contacts-card-button flex w-full items-center gap-3 px-4 py-2.5 text-left"
            onClick={row.onClick}
          >
            {content}
          </button>
        ) : (
          <div key={row.key} className="app-contacts-card-row flex items-center gap-3 px-4 py-2.5">{content}</div>
        );
      })}
    </div>
  );
}

/** Copies a value to the clipboard and briefly confirms with a check mark. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopyValue(value);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={copy}
      className="app-contacts-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
