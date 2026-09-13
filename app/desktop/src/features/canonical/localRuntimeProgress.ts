import type { Message } from '@/kordi-app/types';
import { withLocalExecutionProgress } from '@/features/chat/localExecutionProgress';

export function localRuntimeProgressForCanonicalPlaceholder(canonicalMessage: Message, localMessage: Message): Message {
  if (!localMessage.turn) return canonicalMessage;
  const canonicalReplyToMessageId = canonicalMessage.replyToMessageId ?? canonicalMessage.turn?.replyToMessageId;
  return {
    ...localMessage,
    id: canonicalMessage.id,
    role: canonicalMessage.role,
    replyToMessageId: canonicalReplyToMessageId ?? localMessage.replyToMessageId,
    sourceMessage: canonicalMessage.sourceMessage ?? localMessage.sourceMessage,
    replyAliasIds: canonicalMessage.replyAliasIds ?? localMessage.replyAliasIds,
    conversationSequence: canonicalMessage.conversationSequence ?? localMessage.conversationSequence,
    turn: withLocalExecutionProgress(localMessage.turn, {
      ...localMessage.turn,
      id: canonicalMessage.turn?.id ?? localMessage.turn.id,
      sessionId: canonicalMessage.turn?.sessionId ?? localMessage.turn.sessionId,
      replyToMessageId: canonicalReplyToMessageId ?? localMessage.turn.replyToMessageId,
      sourceMessage: canonicalMessage.turn?.sourceMessage ?? localMessage.turn.sourceMessage,
      pendingCollaborationAgentRequest: canonicalMessage.turn?.pendingCollaborationAgentRequest ?? localMessage.turn.pendingCollaborationAgentRequest,
    }),
  };
}
