import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { CloudSelfAgentExecutionInput } from './useDesktopAgentReadiness';
import { cloudSelfAgentStoppedReply, settledCloudSelfAgentTurn } from './cloudSelfAgentTerminalReply';

/**
 * What the transcript shows for a request this Mac executes. The native
 * turn's snapshots show while it runs. A stop settles the reply as stopped at
 * once and keeps it so: the turn's own cancelling and cancelled snapshots no
 * longer reach the transcript, so the reply never shows running again or
 * changes its wording before the stored reply arrives.
 */
export function createCloudSelfAgentTurnPresenter({
  requestMessageId,
  sessionId,
  setLocalTurns,
  canPresent,
}: {
  requestMessageId: string;
  sessionId: string;
  setLocalTurns: CloudSelfAgentExecutionInput['setLocalTurns'];
  canPresent: () => boolean;
}) {
  let stopped = false;
  let lastTurn: DesktopChatTurnSnapshot | null = null;
  let streamedText = '';
  const present = (turn: DesktopChatTurnSnapshot) => {
    if (!canPresent()) return;
    setLocalTurns((current) => ({ ...current, [requestMessageId]: turn }));
  };
  return {
    get stopped() { return stopped; },
    get lastTurn() { return lastTurn; },
    get streamedText() { return streamedText; },
    /** A snapshot of the running turn; ignored once the request was stopped. */
    remember(turn: DesktopChatTurnSnapshot) {
      lastTurn = turn;
      if (turn.assistantText.trim()) streamedText = turn.assistantText;
      if (stopped) return;
      present(turn);
    },
    /** The settled reply; shown whatever came before. */
    settle(turn: DesktopChatTurnSnapshot) {
      lastTurn = turn;
      present(turn);
    },
    /** Shows the reply as stopped with the text streamed so far. */
    stop() {
      if (stopped) return;
      stopped = true;
      present(settledCloudSelfAgentTurn(lastTurn ?? {
        id: `stopped:${requestMessageId}`, sessionId, prompt: '', status: 'cancelling', message: '',
        assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false, replyToMessageId: requestMessageId,
      }, cloudSelfAgentStoppedReply(streamedText)));
    },
  };
}
