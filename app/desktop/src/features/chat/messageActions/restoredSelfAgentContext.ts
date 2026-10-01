import type { Message } from '@/kordi-app/types';
import type { DesktopChatContextMessage } from '@/lib/desktop';

function messageAuthorKind(message: Message): 'human' | 'agent' {
  if (message.senderType === 'agent' || message.role === 'owned-agent' || message.role === 'external-agent') return 'agent';
  return 'human';
}

function messageContextText(message: Message): string {
  return (message.turn?.assistantText ?? message.text).trim();
}

function restoredSelfAgentContextMessageId(message: Message): string | null {
  const ids = [
    message.id,
    message.entryId,
    ...(message.replyAliasIds ?? []),
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean);
  const cloudMessageId = ids.find((id) => id.startsWith('msg:cloud:self:'));
  if (cloudMessageId) return cloudMessageId;
  if (!message.isForkSnapshot) return null;
  return ids.find((id) => id.startsWith('msg:')) ?? ids[0] ?? null;
}

export function restoredSelfAgentContextMessages(messages: readonly Message[]): DesktopChatContextMessage[] {
  return messages.flatMap((message) => {
    if (message.messageAction?.kind === 'forward') return [];
    const id = restoredSelfAgentContextMessageId(message);
    const text = messageContextText(message);
    if (!id || !text) return [];
    const authorKind = messageAuthorKind(message);
    return [{
      id,
      authorName: message.sender?.trim() || (authorKind === 'agent' ? 'Kordi' : 'Me'),
      authorKind,
      text,
      createdAtMs: null,
    }];
  });
}
