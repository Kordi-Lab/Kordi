import { useId, useMemo, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown, ChevronRight, Search, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

// Shared settings layout: a heading followed by rows separated by thin
// dividers. Each row has a title, an optional one-line description, and one
// control on the right. Every settings surface uses these so they read alike.

type SettingsSectionProps = {
  title?: ReactNode;
  /** Accessible name when the visible title is abbreviated (for example a letter). */
  ariaLabel?: string;
  description?: ReactNode;
  /** `compact` renders a small muted heading for dense grouped lists. */
  size?: 'default' | 'compact';
  id?: string;
  className?: string;
  children: ReactNode;
};

export function SettingsSection({ title, ariaLabel, description, size = 'default', id, className, children }: SettingsSectionProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel || !title ? undefined : headingId}
      className={cn('app-settings-section', size === 'compact' ? 'pt-5 first:pt-1' : 'pt-9 first:pt-0', className)}
    >
      {title ? (
        <h2
          id={headingId}
          className={size === 'compact'
            ? 'm-0 pb-1 text-[12px] font-medium text-slate-500'
            : 'm-0 pb-2 text-[15px] font-semibold tracking-[-0.01em] text-white'}
        >
          {title}
        </h2>
      ) : null}
      {description ? <p className="m-0 pb-2 text-[12px] leading-5 text-slate-400">{description}</p> : null}
      <div className="app-settings-rows divide-y divide-[color:var(--app-divider)]">{children}</div>
    </section>
  );
}

type SettingsRowProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Exactly one control: a select, switch, button, or value. */
  control?: ReactNode;
  icon?: ReactNode;
  /** Makes the whole row a button, for navigation rows. */
  onClick?: () => void;
  chevron?: boolean;
  /** Content revealed under the row, such as an inline sign-in flow. */
  children?: ReactNode;
  className?: string;
  role?: string;
  ariaLabel?: string;
  ariaLive?: 'polite';
};

export function SettingsRow({ title, description, control, icon, onClick, chevron, children, className, role, ariaLabel, ariaLive }: SettingsRowProps) {
  // Buttons may only hold phrasing content, so button rows use spans.
  const Text = onClick ? 'span' : 'div';
  const body = (
    <>
      {icon ? <span className="grid h-8 w-8 shrink-0 place-items-center">{icon}</span> : null}
      <Text className="min-w-0 flex-1">
        <Text className="block text-[13px] font-medium leading-5 text-white">{title}</Text>
        {description ? <Text data-settings-row-description="" className="mt-0.5 block text-[12px] leading-5 text-slate-400">{description}</Text> : null}
      </Text>
      {control ? <Text className="flex max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">{control}</Text> : null}
      {chevron ? <ChevronRight aria-hidden="true" className="app-settings-row-chevron h-3.5 w-3.5 shrink-0 text-slate-500" /> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        className={cn('app-settings-row app-settings-row-button -mx-2 flex min-h-[58px] w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 text-left', className)}
      >
        {body}
      </button>
    );
  }

  return (
    <div role={role} aria-label={ariaLabel} aria-live={ariaLive} className={cn('app-settings-row py-3.5', className)}>
      <div className="flex min-h-8 items-center gap-3">{body}</div>
      {children ? <div className="pt-3">{children}</div> : null}
    </div>
  );
}

type SettingsSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  label: string;
  options: Array<{ value: string; label: string }>;
  className?: string;
};

/** Borderless select with a chevron, sized for the right side of a settings row. */
export function SettingsSelect({ label, options, className, ...props }: SettingsSelectProps) {
  return (
    <span className={cn('relative inline-flex max-w-[260px] items-center', className)}>
      <select
        {...props}
        aria-label={label}
        className="app-settings-select h-8 w-full min-w-0 cursor-pointer appearance-none truncate rounded-lg border-0 bg-transparent py-1 pl-2.5 pr-8 text-right text-[13px] font-medium text-white outline-none hover:bg-[color:var(--app-quiet-control-hover-bg)] focus-visible:ring-2 focus-visible:ring-[var(--app-quiet-control-focus-ring)] disabled:cursor-default disabled:opacity-50"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-slate-400" />
    </span>
  );
}

export function SettingsSwitch({ enabled, label, onChange, disabled }: {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        'app-settings-switch relative h-6 w-10 shrink-0 rounded-full border outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[var(--app-quiet-control-focus-ring)] focus-visible:ring-offset-2 disabled:opacity-50',
        enabled
          ? 'border-[color:var(--app-sidebar-accent)] bg-[color:var(--app-sidebar-accent)]'
          : 'border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] hover:bg-[color:var(--app-control-hover)]',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
          enabled ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}

export type SettingsNavItem<T extends string> = { id: T; label: string; icon: LucideIcon; keywords?: string[] };
export type SettingsNavGroup<T extends string> = { label: string; items: Array<SettingsNavItem<T>> };

/** Settings rail: a search field, then labelled groups of icon and label items. */
export function SettingsNav<T extends string>({ groups, activeId, onSelect, className }: {
  groups: Array<SettingsNavGroup<T>>;
  activeId: T;
  onSelect: (id: T) => void;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => !needle
          || [item.label, group.label, ...(item.keywords ?? [])].join(' ').toLowerCase().includes(needle)),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  return (
    <nav aria-label="Settings" className={cn('app-settings-nav flex min-h-0 flex-col', className)}>
      <label className="relative block">
        <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          aria-label="Search settings"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="app-input-shell app-flat-input h-9 w-full rounded-lg pl-8 pr-2.5 text-[13px] text-white outline-none placeholder:text-slate-500"
        />
      </label>
      {visibleGroups.map((group) => (
        <div key={group.label} className="pt-5">
          <div className="px-2.5 pb-1.5 text-[12px] font-medium text-slate-500">{group.label}</div>
          <div className="grid gap-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeId;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    'app-settings-nav-item flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-300',
                    active && 'app-settings-nav-item-active font-medium text-white',
                  )}
                >
                  <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', active ? 'text-white' : 'text-slate-400')} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {visibleGroups.length === 0 ? <p className="px-2.5 pt-5 text-[12px] text-slate-500">No settings match.</p> : null}
    </nav>
  );
}
