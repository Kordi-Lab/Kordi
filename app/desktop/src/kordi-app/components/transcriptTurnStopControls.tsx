import type { AgentRequestStopAction, AgentRequestStopHandler } from '@/features/chat/agentRequestStop';
import { Square } from 'lucide-react';
import { useState } from 'react';
import type { CollaborationAgentRequestControl } from '../types';

export type StopCollaborationAgentRequestHandler = (request: CollaborationAgentRequestControl) => Promise<void> | void;
export type StopActiveTurnHandler = AgentRequestStopHandler;

/** A quiet "Stop" text button, the same shape as the background-session stop. */
export function TurnStopButton({
  onStop,
  ariaLabel = 'Stop agent request',
  stoppingLabel = 'Stopping agent request',
}: {
  onStop?: StopActiveTurnHandler;
  ariaLabel?: string;
  stoppingLabel?: string;
}) {
  const [stopping, setStopping] = useState(false);
  if (!onStop) return null;

  return (
    <button
      type="button"
      className="app-button-quiet app-turn-stop-button inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none disabled:cursor-default"
      aria-label={stopping ? stoppingLabel : ariaLabel}
      title={stopping ? 'Stopping…' : ariaLabel}
      disabled={stopping}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        setStopping(true);
        // A stop that found nothing to stop offers Stop again instead of
        // waiting for a terminal state that will not come.
        void Promise.resolve()
          .then(onStop)
          .then((stopped) => { if (stopped === false) setStopping(false); }, () => setStopping(false));
      }}
    >
      <Square className="h-[9px] w-[9px] fill-current" aria-hidden="true" />
      {stopping ? 'Stopping…' : 'Stop'}
    </button>
  );
}

/**
 * Stop at the end of a running reply's status line. It stays from admission
 * until the terminal state, including while the reply streams text.
 */
export function AgentRequestStop({ action }: { action: AgentRequestStopAction }) {
  return <span className="app-turn-stop inline-flex shrink-0 items-center" data-agent-request-stop="status"><TurnStopButton key={action.requestKey} onStop={action.onStop} /></span>;
}
