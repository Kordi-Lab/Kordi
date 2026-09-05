import { formatDesktopContactRequestTimeLabel } from '@/lib/time';
import { cn } from '@/lib/utils';

import type { Message } from '../types';

function messageTimeAttributes(msg: Message) {
  const time = msg.time.trim();
  const timestamp = typeof msg.timestampMs === 'number' && Number.isFinite(msg.timestampMs)
    ? new Date(msg.timestampMs)
    : null;
  const dateTime = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : undefined;
  return { time, dateTime };
}

export function MessageEditedLabel({ msg }: { msg: Message }) {
  if (!msg.editedAt) return null;
  return (
    <span className="app-message-edited-label shrink-0 whitespace-nowrap" data-message-edited-label="true">
      edited
    </span>
  );
}

export function MessageHoverTime({ msg, side }: { msg: Message; side: 'own' | 'peer' }) {
  const { time, dateTime } = messageTimeAttributes(msg);
  if (!time) return null;

  return (
    <time
      className={cn(
        'app-message-hover-time pointer-events-none w-max shrink-0 whitespace-nowrap pb-1 text-[10px] leading-none tabular-nums text-[color:var(--utility-muted-text)] opacity-0 transition-opacity duration-100',
        side === 'own' ? 'text-right' : 'text-left',
      )}
      dateTime={dateTime}
      title={time}
    >
      {time}
    </time>
  );
}

export function ContactRequestTime({ value }: { value: string }) {
  const timestampMs = Date.parse(value);
  const dateTime = Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined;
  return (
    <time className="shrink-0 text-[11px] text-slate-400" dateTime={dateTime}>
      {formatDesktopContactRequestTimeLabel(value)}
    </time>
  );
}
