import { cn } from '@/lib/utils';

import type { Message } from '../types';

export function MessageHoverTime({ msg, side }: { msg: Message; side: 'own' | 'peer' }) {
  const time = msg.time.trim();
  if (!time) return null;
  const timestamp = typeof msg.timestampMs === 'number' && Number.isFinite(msg.timestampMs)
    ? new Date(msg.timestampMs)
    : null;
  const dateTime = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : undefined;

  return (
    <time
      className={cn(
        'app-message-hover-time pointer-events-none w-10 shrink-0 pb-1 text-[10px] leading-none tabular-nums text-[color:var(--utility-muted-text)] opacity-0 transition-opacity duration-100',
        side === 'own' ? 'text-right' : 'text-left',
      )}
      dateTime={dateTime}
      title={time}
    >
      {time}
    </time>
  );
}
