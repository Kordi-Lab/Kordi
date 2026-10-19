import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/** A titled, collapsible block of rows in the Contacts list column. */
export function ContactsListSection({
  label,
  count,
  expanded,
  onToggle,
  className,
  children,
}: {
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <section aria-label={label} className={cn('app-contacts-section', className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="app-contacts-group-row flex w-full items-center gap-1 text-left"
      >
        <span className="min-w-0 truncate">{label}</span>
        <Chevron className="app-contacts-group-chevron h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1" />
        {count !== undefined ? <span className="app-contacts-group-count">{count}</span> : null}
      </button>
      {expanded ? <div className="grid gap-px">{children}</div> : null}
    </section>
  );
}
