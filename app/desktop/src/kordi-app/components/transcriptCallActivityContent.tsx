import {
  ArrowDownLeft,
  ArrowUpRight,
  Phone,
  UsersRound,
  Video,
} from 'lucide-react';

import type { Message } from '@/kordi-app/types';
import type { MessageCallActivity } from '@/kordi-app/types/message';

function callKindLabel(kind: MessageCallActivity['kind']): string {
  if (kind === 'video') return 'video call';
  if (kind === 'meeting') return 'group call';
  return 'voice call';
}

function callActivityTitle(activity: MessageCallActivity): string {
  const noun = callKindLabel(activity.kind);
  if (activity.outcome === 'missed') return `Missed ${noun}`;
  if (activity.outcome === 'canceled') return `Canceled ${noun}`;
  if (activity.outcome === 'ended') return `${noun[0]?.toUpperCase()}${noun.slice(1)} ended`;
  return `${activity.direction === 'outgoing' ? 'Outgoing' : 'Incoming'} ${noun}`;
}

function callDurationWords(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds} sec`;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  if (minutes < 60) return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours} hr ${minuteRemainder} min` : `${hours} hr`;
}

function callActivityDetail(message: Message, activity: MessageCallActivity): string {
  if (activity.outcome === 'ringing') return `${message.time} · Ringing`;
  if (activity.outcome === 'completed' && activity.durationSeconds !== null
    && activity.durationSeconds !== undefined) {
    return `${message.time} · ${callDurationWords(activity.durationSeconds)}`;
  }
  if (activity.outcome === 'ended') return `${message.time} · Ended`;
  return message.time;
}

export function TranscriptCallActivityContent({ message }: { message: Message }) {
  const activity = message.callActivity;
  if (!activity) return null;
  const title = callActivityTitle(activity);
  const detail = callActivityDetail(message, activity);
  const CallIcon = activity.kind === 'voice' ? Phone : activity.kind === 'video' ? Video : UsersRound;
  const DirectionIcon = activity.direction === 'outgoing' ? ArrowUpRight : ArrowDownLeft;
  return (
    <div
      className="app-call-activity"
      data-direction={activity.direction}
      data-outcome={activity.outcome}
      aria-label={`${title}, ${detail}`}
    >
      <div className="app-call-activity-copy">
        <strong>{title}</strong>
        <span>
          <DirectionIcon aria-hidden="true" />
          {detail}
        </span>
      </div>
      <span className="app-call-activity-icon" aria-hidden="true">
        <CallIcon />
      </span>
    </div>
  );
}
