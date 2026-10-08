import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import type { ConnectorDefinition } from './connectorsModel';

export function Badge({ children, tone, inDialog = false }: { children: ReactNode; tone: 'amber' | 'muted'; inDialog?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium',
        inDialog
          // Body-portaled dialogs: `body.theme-light` is set by the app shell.
          ? tone === 'amber'
            ? 'bg-amber-400/10 text-amber-100 [.theme-light_&]:bg-amber-500/15 [.theme-light_&]:text-amber-900'
            : 'bg-[color:var(--app-transient-raised-bg)] text-[color:var(--app-transient-muted-text)]'
          : tone === 'amber' ? 'bg-amber-400/10 text-amber-100' : 'bg-white/[0.06] text-slate-300',
      )}
    >
      {children}
    </span>
  );
}

export function ConnectorBadge({ definition }: { definition: ConnectorDefinition }) {
  return definition.experimental ? <Badge tone="amber">Experimental</Badge> : null;
}
