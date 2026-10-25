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
 * moment later, under another id. Keyed by the request it answers, the row
 * stays mounted, so its slide and fade carry on instead of restarting. The
 * not-started notice keeps a row of its own, and a shared key goes to the
 * first row only.
 */
export function transcriptMessageRenderKeys(messages: readonly Message[]) {
  const keys = new Map<Message, string>();
  const requestKeyById = new Map<string, string>();
  messages.forEach((message, index) => {
    const key = transcriptMessageRenderKey(message, index);
    keys.set(message, key);
    if (message.role !== 'user' && message.role !== 'person') return;
    for (const id of [message.id, message.clientMessageId, message.entryId]) {
      if (id?.trim()) requestKeyById.set(id.trim(), key);
    }
  });
  const used = new Set(keys.values());
  for (const message of messages) {
    if (!isSelfAgentReplyRow(message)) continue;
    const pendingRequestId = message.id?.startsWith(SELF_AGENT_REPLY_ID_PREFIXES[0])
      ? message.id.slice(SELF_AGENT_REPLY_ID_PREFIXES[0].length)
      : undefined;
    const requestKey = [pendingRequestId, message.replyToMessageId, ...(message.replyAliasIds ?? [])]
      .map((id) => id?.trim() && requestKeyById.get(id.trim()))
      .find(Boolean);
    const replyKey = requestKey ? `self-agent-reply:${requestKey}` : null;
    if (!replyKey || used.has(replyKey)) continue;
    used.add(replyKey);
    keys.set(message, replyKey);
  }
  return keys;
}
