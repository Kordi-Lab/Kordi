import type { Message } from '@/kordi-app/types';

export function transcriptMessageRenderKey(message: Message, index: number) {
  if (message.clientMessageId?.trim()) return `client-message:${message.clientMessageId}`;
  if (message.id?.trim()) return `message:${message.id}`;
  return [
    'message:fallback',
    index,
    message.role,
    message.sender ?? '',
    message.senderType ?? '',
    message.isOwnMessage ? 'own' : 'peer',
  ].join(':');
}

const SELF_AGENT_REPLY_ID_PREFIXES = ['msg:cloud:self:pending:', 'msg:cloud:self:response:'];

function isSelfAgentReplyRow(message: Message) {
  const id = message.id?.trim() ?? '';
  return message.role === 'owned-agent'
    && !message.clientMessageId?.trim()
    && !id.endsWith(':not-started')
    && SELF_AGENT_REPLY_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Render keys for one transcript.
 *
 * A Cloud agent reply starts as a pending row and becomes its stored reply a
 * moment later, under another id. Both name the request they answer (the
 * pending id's suffix, and the reply's first alias, its parent), so keyed by
 * that request id the row stays mounted and its slide and fade carry on. The
 * key does not depend on the request row being loaded. The not-started notice
 * keeps a row of its own, and a shared key goes to the first row only.
 */
export function transcriptMessageRenderKeys(messages: readonly Message[]) {
  const keys = new Map<Message, string>();
  messages.forEach((message, index) => keys.set(message, transcriptMessageRenderKey(message, index)));
  const used = new Set(keys.values());
  for (const message of messages) {
    if (!isSelfAgentReplyRow(message)) continue;
    const id = message.id ?? '';
    const requestId = (id.startsWith(SELF_AGENT_REPLY_ID_PREFIXES[0])
      ? id.slice(SELF_AGENT_REPLY_ID_PREFIXES[0].length)
      : message.replyAliasIds?.[0])?.trim();
    const replyKey = requestId ? `self-agent-reply:${requestId}` : null;
    if (!replyKey || used.has(replyKey)) continue;
    used.add(replyKey);
    keys.set(message, replyKey);
  }
  return keys;
}
