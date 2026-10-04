import type { Message } from '../types';
import { formatDesktopClockTime } from '@/lib/time';
import { AgentOwnerTag } from './AgentOwnerTag';
import { PipSenderTag } from './planCard';

export function ThreadMessageHeader({ msg, name, ownerName }: { msg: Message; name: string; ownerName?: string | null }) {
  const timestamp = typeof msg.timestampMs === 'number' && Number.isFinite(msg.timestampMs) ? new Date(msg.timestampMs) : null;
  const dateTime = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : undefined;
  const time = dateTime ? formatDesktopClockTime(timestamp!) : msg.time;
  return (
    <div className="app-thread-message-header" data-transcript-leading-decoration="true">
      <span className="app-thread-message-author">{name}<PipSenderTag avatarUrl={msg.senderProfileImageUrl} /></span>
      <AgentOwnerTag name={ownerName} />
      <time dateTime={dateTime} className="app-thread-message-time">{time}</time>
    </div>
  );
}
