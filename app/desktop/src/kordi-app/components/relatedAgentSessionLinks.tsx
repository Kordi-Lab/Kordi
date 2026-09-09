import { Bot, ChevronRight } from 'lucide-react';
import { useAgentSubsession } from '@/features/cloud/useAgentSubsession';
import { agentSubsessionStatusNotice } from '@/features/cloud/agentSubsessionTasks';
import { useBackgroundSessionControl } from '@/features/chat/useBackgroundSessionControl';
import { BackgroundSessionStopButton } from './backgroundSessionStopControl';

import {
  normalizedRelatedAgentSessionStatus,
  runStatusFromTurn,
  type RelatedAgentSession,
  type RelatedAgentSessionRunStatus,
} from '@/features/chat/relatedAgentSessions';
import { cn } from '@/lib/utils';

const STATUS: Record<RelatedAgentSessionRunStatus, { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'animate-pulse bg-sky-500 motion-reduce:animate-none' },
  done: { label: 'Done', dot: 'bg-emerald-500' },
  failed: { label: 'Failed', dot: 'bg-rose-500' },
  stopped: { label: 'Stopped', dot: 'bg-slate-400' },
};

export function RelatedAgentSessionLinks({
  sessions,
  agentName,
  statusBySessionId,
  onOpen,
}: {
  sessions: RelatedAgentSession[];
  agentName?: string | null;
  statusBySessionId?: ReadonlyMap<string, RelatedAgentSessionRunStatus>;
  onOpen?: (sessionId: string, isSubsession?: boolean) => void;
}) {
  if (sessions.length === 0) return null;

  return (
    <div
      className="relative ml-4 mt-1 grid w-[30rem] max-w-[calc(100%-1rem)] gap-0.5"
      data-related-agent-sessions="true"
      data-related-agent-session-style="thread-preview"
    >
      <span className="pointer-events-none absolute -left-3 -top-3 h-7 w-3 rounded-bl-[9px] border-b border-l border-[color:var(--app-divider)]" aria-hidden="true" />
      {sessions.map((session) => <SubsessionLink key={session.sessionId} session={session} agentName={agentName}
        status={statusBySessionId?.get(session.sessionId)} onOpen={onOpen} />)}
    </div>
  );
}

function SubsessionLink({ session, agentName, status, onOpen }: {
  session: RelatedAgentSession; agentName?: string | null; status?: RelatedAgentSessionRunStatus; onOpen?: (id: string, isSubsession?: boolean) => void;
}) {
  const { snapshot: shared, error, accountId } = useAgentSubsession(session.sessionId);
  const control = useBackgroundSessionControl(session.sessionId, shared, accountId);
  const snapshot = control.remoteSnapshot;
  const localTurn = control.turn && (!snapshot?.startedAtMs || !control.turn.startedAtMs || snapshot.startedAtMs <= control.turn.startedAtMs) ? control.turn : null;
  const resolved = localTurn ? runStatusFromTurn(localTurn) : snapshot ? normalizedRelatedAgentSessionStatus(snapshot.status) : status ?? normalizedRelatedAgentSessionStatus(session.status);
  const presentation = STATUS[resolved];
  const notice = control.stopping ? 'Stopping…' : localTurn ? null : error ? 'Sync unavailable' : snapshot ? agentSubsessionStatusNotice(snapshot) : null;
  return <div className="flex items-center gap-1" data-related-agent-session-id={session.sessionId}>
        <button
          key={session.sessionId}
          type="button"
          className="app-button-quiet group grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-1.5 py-1 text-left disabled:cursor-default disabled:opacity-60"
          onClick={() => onOpen?.(session.sessionId, true)}
          disabled={!onOpen}
          aria-label={`Open background agent session: ${session.title}`}
        >
          <span className="row-span-2 grid h-5 w-5 place-items-center self-center text-[color:var(--app-sidebar-accent)]" aria-hidden="true">
            <Bot className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-4 text-[color:var(--utility-foreground)]" title={session.title}>
            {snapshot?.title ?? session.title}
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] font-semibold leading-4 text-[color:var(--app-sidebar-accent)]">
            Open
            <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
          <span className="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">
            <span className="font-medium text-[color:var(--utility-foreground)]">{snapshot?.agentDisplayName || agentName?.trim() || 'Agent'}</span>
            <span aria-hidden="true"> · </span>
            <span className="truncate">Background session</span>
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1"
              data-related-agent-session-status={resolved}
              aria-label={`Status: ${notice ?? presentation.label}`}
              aria-live="polite"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', notice ? 'bg-slate-400' : presentation.dot)} aria-hidden="true" />
              {notice ?? presentation.label}
            </span>
          </span>
        </button>
        <BackgroundSessionStopButton control={control} title={snapshot?.title ?? session.title} />
      </div>;
}
