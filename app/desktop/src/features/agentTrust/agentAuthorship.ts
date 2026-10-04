// Which messages an agent wrote, for the "AI" chip, "(AI)" labels on quotes
// and forwards, and notification titles.
import { isPipAvatarUrl } from '@/features/pip/pipIdentity';
import type { Message } from '@/kordi-app/types';

/** True for agent turns, agent roles, and PiP. */
export function isAgentAuthoredMessage(
  message: Pick<Message, 'turn' | 'role' | 'senderProfileImageUrl'>,
): boolean {
  return Boolean(message.turn)
    || message.role === 'owned-agent'
    || message.role === 'external-agent'
    || isPipAvatarUrl(message.senderProfileImageUrl);
}

/** The `sourceMessageKind` a quote or forward declares for its source. */
export function sourceMessageKindForMessage(
  message: Pick<Message, 'turn' | 'role' | 'senderProfileImageUrl'>,
): 'agent-turn' | 'text' {
  return isAgentAuthoredMessage(message) ? 'agent-turn' : 'text';
}

/** "{name} (AI)" for agent-written messages, the name alone otherwise. */
export function withAiLabel(label: string, agentAuthored: boolean): string {
  return agentAuthored ? `${label} (AI)` : label;
}

/** Names a quoted or forwarded sender, marking messages an agent wrote. The
 * mark comes from the source message's kind, which the sender's app declares. */
export function sourceSenderLabelWithAi(label: string, sourceMessageKind?: string | null): string {
  return withAiLabel(label, sourceMessageKind === 'agent-turn');
}
