import type { ComponentType, ReactNode } from 'react';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Header and search shared by every list in the sidebar session panel (Chats, Contacts, Factory),
 * so the lists line up when switching pages.
 */
export function SidebarListHeader({ title, after, children }: {
  title: ReactNode;
  /** Shown right after the title, such as a sync indicator. */
  after?: ReactNode;
  /** Actions on the right. */
  children?: ReactNode;
}) {
  return (
    <div className="app-chat-sidebar-header mb-2 flex items-center justify-between gap-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <h2 className="m-0 shrink-0 truncate text-[15px] font-semibold text-white">{title}</h2>
        {after}
      </div>
      {children ? <div className="app-chat-sidebar-actions flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function SidebarListAction({ icon: Icon, label, onClick, disabled, expanded }: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      className="app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-[10px] p-0 transition disabled:pointer-events-none disabled:opacity-50"
      title={label}
      aria-label={label}
    >
      <Icon className="h-4 w-4 stroke-[2.2]" aria-hidden="true" />
    </button>
  );
}

export function SidebarSearchField({ value, onChange, placeholder, label, className }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
  className?: string;
}) {
  return (
    <label className={cn('app-input-shell app-workspace-search mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5', className)}>
      <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="w-full min-w-0 bg-transparent text-[13px] text-white outline-none placeholder:text-slate-400"
      />
    </label>
  );
}
