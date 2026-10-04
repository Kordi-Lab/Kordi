import type { Message } from '../types';
import { formatDesktopClockTime } from '@/lib/time';
import { AgentAiChip, AgentOwnerTag } from './AgentOwnerTag';
import { PipSenderTag } from './planCard';

/** `ai` marks an agent message with the same "AI" chip as the bubble layout. */
export function ThreadMessageHeader({ msg, name, ownerName, ai = false }: { msg: Message; name: string; ownerName?: string | null; ai?: boolean }) {
  const timestamp = typeof msg.timestampMs === 'number' && Number.isFinite(msg.timestampMs) ? new Date(msg.timestampMs) : null;
  const dateTime = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : undefined;
  const time = dateTime ? formatDesktopClockTime(timestamp!) : msg.time;
  return (
    <div className="app-thread-message-header" data-transcript-leading-decoration="true">
      <span className="app-thread-message-author">{name}<PipSenderTag avatarUrl={msg.senderProfileImageUrl} /></span>
      {ai ? <AgentAiChip message={msg} /> : null}
      <AgentOwnerTag name={ownerName} />
      <time dateTime={dateTime} className="app-thread-message-time">{time}</time>
    </div>
  );
}
