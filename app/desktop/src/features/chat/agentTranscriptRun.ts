import type { Message } from '@/kordi-app/types';

function agentTranscriptRunKey(message?: Message) {
  if (!message || message.role === 'system' || message.role === 'action' || message.role === 'edit') return null;
  const senderType = message.senderType
    ?? (message.role === 'user' || message.role === 'person' ? 'human' : 'agent');
  if (senderType !== 'agent' || message.role === 'user' || message.role === 'person') return null;
  const senderKey = message.senderIdentityId?.trim()
    || message.senderAvatarSeed?.trim()
    || message.senderProfileImageUrl?.trim()
    || message.sender?.trim();
  return senderKey ? `agent:${senderKey}` : null;
}

/** The row above is the same agent, so the agent avatar is shown once per run. */
export function continuesAgentTranscriptRun(
  messages: readonly Message[],
  index: number,
  timeSeparators: readonly (string | null)[] = [],
) {
  if (timeSeparators[index]) return false;
  const currentKey = agentTranscriptRunKey(messages[index]);
  return Boolean(currentKey && currentKey === agentTranscriptRunKey(messages[index - 1]));
}
