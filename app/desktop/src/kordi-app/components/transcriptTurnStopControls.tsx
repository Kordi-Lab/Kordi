import { agentRequestStopTarget, type AgentRequestStopHandler } from '@/features/chat/agentRequestStop';
import { Square } from 'lucide-react';
import { useState } from 'react';
import type { CollaborationAgentRequestControl, DesktopChatTurnSnapshot, Message } from '../types';

export type StopCollaborationAgentRequestHandler = (request: CollaborationAgentRequestControl) => Promise<void> | void;
export type StopActiveTurnHandler = AgentRequestStopHandler;

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
      className="app-collaboration-agent-stop-button inline-grid h-[18px] w-[18px] place-items-center rounded-full border border-slate-500/25 bg-slate-800/30 text-slate-400 transition hover:border-rose-300/40 hover:bg-rose-400/[0.08] hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-55"
      aria-label={stopping ? stoppingLabel : ariaLabel}
      title={stopping ? 'Stopping…' : ariaLabel}
      disabled={stopping}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        setStopping(true);
        void Promise.resolve(onStop()).catch(() => {
          setStopping(false);
        });
      }}
    >
      <Square className="h-2 w-2 fill-current" aria-hidden="true" />
    </button>
  );
}

/**
 * Stop beside the time in a running reply's header. It stays from admission
 * until the terminal state, including while the reply streams text.
 */
export function AgentRequestHeaderStop({
  turn,
  message,
  historical = false,
  onStopActiveTurn,
  onStopCollaborationAgentRequest,
}: {
  turn: DesktopChatTurnSnapshot | null | undefined;
  message?: Pick<Message, 'role' | 'senderOwnerName'>;
  historical?: boolean;
  onStopActiveTurn?: StopActiveTurnHandler;
  onStopCollaborationAgentRequest?: StopCollaborationAgentRequestHandler;
}) {
  const target = historical ? null : agentRequestStopTarget(turn, message);
  if (target?.kind === 'collaboration' && onStopCollaborationAgentRequest) {
    return <span className="app-thread-message-stop inline-flex shrink-0 items-center" data-agent-request-stop="header"><TurnStopButton key={target.turnId} onStop={() => onStopCollaborationAgentRequest(target.request)} /></span>;
  }
  if (target?.kind === 'turn' && onStopActiveTurn) {
    return <span className="app-thread-message-stop inline-flex shrink-0 items-center" data-agent-request-stop="header"><TurnStopButton key={target.turnId} onStop={onStopActiveTurn} /></span>;
  }
  return null;
}

export function CollaborationAgentStopButton({
  request,
  onStop,
}: {
  request: CollaborationAgentRequestControl;
  onStop?: StopCollaborationAgentRequestHandler;
}) {
  if (!onStop) return null;
  return <TurnStopButton onStop={() => onStop(request)} />;
}
