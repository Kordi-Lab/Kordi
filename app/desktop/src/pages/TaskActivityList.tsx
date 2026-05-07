import { Bot, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { SessionTaskActivity, SessionTaskParticipant } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

function taskStatusClass(status: string) {
  const normalized = status.trim().toLowerCase();
  if (['failed', 'timeout', 'cancelled'].includes(normalized)) return 'app-badge-attention';
  return 'app-badge-neutral';
}

function taskStatusLabel(status: string) {
  const normalized = status.trim().toLowerCase();
  if (['complete', 'completed'].includes(normalized)) return 'Complete';
  if (normalized === 'processing') return 'Running';
  if (normalized === 'cancelled') return 'Stopped';
  if (normalized === 'timeout') return 'Timed out';
  if (normalized === 'failed') return 'Failed';
  return status || 'Pending';
}

function participantLabel(participant: SessionTaskParticipant | null | undefined, fallback: string) {
  return participant?.name?.trim() || fallback;
}

function participantAvatar(participant: SessionTaskParticipant, index: number) {
  return (
    <IdentityAvatar
      key={`${participant.id}-${index}`}
      kind={participant.kind === 'agent' ? 'agent' : 'human'}
      seed={participant.avatarKey || participant.agentId || participant.humanId || participant.id || participant.name}
      imageUrl={participant.profileImageUrl}
      name={participant.name}
      className="h-6 w-6 border border-white/10"
    />
  );
}

export function TaskActivityList({
  activities,
  emptyMessage,
}: {
  activities: SessionTaskActivity[];
  emptyMessage: string;
}) {
  if (activities.length === 0) {
    return <div className="app-inspector-empty">{emptyMessage}</div>;
  }

  return (
    <div className="space-y-3">
      {activities.map((activity) => {
        const visibleParticipants = activity.participants.slice(0, 4);
        const extraCount = Math.max(0, activity.participants.length - visibleParticipants.length);
        const targetName = participantLabel(activity.target, 'Agent');
        const initiatorName = participantLabel(activity.initiator, 'Participant');
        return (
          <div key={activity.id} className="app-inspector-emphasis">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 app-inspector-heading">
                  <Bot className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                  <span className="truncate">{targetName}</span>
                </div>
                <div className="mt-1 app-inspector-subtext">Delegated by {initiatorName}</div>
              </div>
              <Badge variant="secondary" className={cn('rounded-full px-2.5 py-1', taskStatusClass(activity.status))}>
                {taskStatusLabel(activity.status)}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Users className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <div className="flex -space-x-1.5">
                  {visibleParticipants.map(participantAvatar)}
                </div>
                {extraCount > 0 ? <span className="text-[11px] text-slate-500">+{extraCount}</span> : null}
              </div>
              <div className="truncate text-[11px] text-slate-500">
                {activity.participants.map((participant) => participant.name).join(' • ')}
              </div>
            </div>
            {activity.error ? <div className="mt-2 text-[12px] text-amber-200">{activity.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
