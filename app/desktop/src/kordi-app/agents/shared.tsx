import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function AgentInspectorSection({ title, detail, children, className }: { title: string; detail?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-[18px] border border-white/8 bg-white/[0.025] p-4', className)}>
      <div className="text-[12px] font-medium text-white">{title}</div>
      {detail ? <div className="mt-1 text-[12px] leading-5 text-slate-400">{detail}</div> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function AgentConfigList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="text-sm text-slate-500">{emptyLabel}</div>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="rounded-full border-white/10 px-2.5 py-1 text-[11px] text-slate-200">
          {item}
        </Badge>
      ))}
    </div>
  );
}
