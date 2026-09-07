import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Bot,
  Sparkles,
  User
} from 'lucide-react';
import { type ReactNode } from 'react';
import type {
  ConversationType
} from "../types";

export function TypeBadge({ type, compact = false }: { type: ConversationType; compact?: boolean }) {
  const sizeClassName = compact
    ? 'gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] leading-none [&_svg]:h-2.5 [&_svg]:w-2.5'
    : 'gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none';

  if (type === 'person') {
    return (
      <Badge variant="secondary" className={cn('app-badge-neutral', sizeClassName)}>
        <User className="h-3 w-3" />
        Human
      </Badge>
    );
  }
  if (type === 'owned-agent') {
    return (
      <Badge className={cn('app-badge-owned', sizeClassName)}>
        <Sparkles className="h-3 w-3" />
        My agent
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn('app-badge-neutral', sizeClassName)}>
      <Bot className="h-3 w-3" />
      External agent
    </Badge>
  );
}

export function StatusPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('app-control-chip inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium leading-none [&_svg]:h-2.5 [&_svg]:w-2.5 [&_svg]:opacity-80', className)}>
      {children}
    </div>
  );
}
