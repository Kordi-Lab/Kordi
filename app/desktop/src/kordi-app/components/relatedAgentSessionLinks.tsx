import { Bot, ChevronRight } from 'lucide-react';

import {
  normalizedRelatedAgentSessionStatus,
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
  onOpen?: (sessionId: string) => void;
}) {
  if (sessions.length === 0) return null;

  return (
    <div
      className="relative ml-4 mt-1 grid w-[30rem] max-w-[calc(100%-1rem)] gap-0.5"
      data-related-agent-sessions="true"
      data-related-agent-session-style="thread-preview"
    >
      <span className="pointer-events-none absolute -left-3 -top-3 h-7 w-3 rounded-bl-[9px] border-b border-l border-[color:var(--app-divider)]" aria-hidden="true" />
      {sessions.map((session) => {
        const status = statusBySessionId?.get(session.sessionId)
          ?? normalizedRelatedAgentSessionStatus(session.status);
        const presentation = STATUS[status];
        return <button
          key={session.sessionId}
          type="button"
          className="app-button-quiet group grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-1.5 py-1 text-left disabled:cursor-default disabled:opacity-60"
          onClick={() => onOpen?.(session.sessionId)}
          disabled={!onOpen}
          aria-label={`Open background agent session: ${session.title}`}
          data-related-agent-session-id={session.sessionId}
        >
          <span className="row-span-2 grid h-5 w-5 place-items-center self-center text-[color:var(--app-sidebar-accent)]" aria-hidden="true">
            <Bot className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-4 text-[color:var(--utility-foreground)]" title={session.title}>
            {session.title}
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] font-semibold leading-4 text-[color:var(--app-sidebar-accent)]">
            Open
            <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
          <span className="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">
            <span className="font-medium text-[color:var(--utility-foreground)]">{agentName?.trim() || 'Agent'}</span>
            <span aria-hidden="true"> · </span>
            <span className="truncate">Background session</span>
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1"
              data-related-agent-session-status={status}
              aria-label={`Status: ${presentation.label}`}
              aria-live="polite"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', presentation.dot)} aria-hidden="true" />
              {presentation.label}
            </span>
          </span>
        </button>;
      })}
    </div>
  );
}
