import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function AgentInspectorSection({ title, detail, children, className }: { title: string; detail?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('app-agent-section border-t pt-5', className)}>
      <div className="app-agent-section-title text-[12px] font-medium">{title}</div>
      {detail ? <div className="app-agent-section-detail mt-1 text-[12px] leading-5">{detail}</div> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function AgentConfigList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="app-agent-empty-copy text-[13px]">{emptyLabel}</div>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="app-agent-chip rounded-full px-2.5 py-1 text-[11px]">
          {item}
        </Badge>
      ))}
    </div>
  );
}
