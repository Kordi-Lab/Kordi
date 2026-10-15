import type { Message } from '@/kordi-app/types';
import { generatedAvatarSeedForLabel } from '@/lib/identityLabels';

/**
 * The avatar seed for an agent row: the row's own agent seed, the local agent
 * only for the viewer's own agent, and otherwise a seed generated from the
 * agent's name. Never the conversation's or another agent's picture.
 */
export function agentMessageAvatarSeed(
  message: Pick<Message, 'role' | 'sender' | 'senderAvatarSeed'>,
  localAgentAvatarSeed: string,
  fallbackName?: string | null,
) {
  const seed = message.senderAvatarSeed?.trim();
  if (seed) return seed;
  if (message.role === 'owned-agent') return localAgentAvatarSeed;
  return generatedAvatarSeedForLabel('agent', fallbackName?.trim() || message.sender?.trim() || 'Agent');
}
