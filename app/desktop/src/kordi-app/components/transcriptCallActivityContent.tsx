import type { Message } from '@/kordi-app/types';
import type { MessageCallActivity } from '@/kordi-app/types/message';

function callKindLabel(kind: MessageCallActivity['kind']): string {
  if (kind === 'video') return 'video call';
  if (kind === 'meeting') return 'group call';
  return 'voice call';
}

function callActivityText(activity: MessageCallActivity): string {
  const noun = callKindLabel(activity.kind);
  if (activity.outcome === 'missed') return `Missed ${noun}.`;
  if (activity.outcome === 'canceled') return `Canceled ${noun}.`;
  if (activity.outcome === 'completed' || activity.outcome === 'ended') {
    return `The ${noun} ended.`;
  }
  return `${activity.direction === 'outgoing' ? 'Outgoing' : 'Incoming'} ${noun}.`;
}

function callDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainder = safeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function TranscriptCallActivityContent({ message }: { message: Message }) {
  const activity = message.callActivity;
  if (!activity) return null;
  const text = callActivityText(activity);
  const duration = activity.durationSeconds !== null
    && activity.durationSeconds !== undefined
    ? ` Duration ${callDuration(activity.durationSeconds)}.`
    : '';
  return (
    <span
      className="app-call-activity-inline"
      data-outcome={activity.outcome}
      aria-label={`${text}${duration}`}
    >
      {text}{duration}
    </span>
  );
}
