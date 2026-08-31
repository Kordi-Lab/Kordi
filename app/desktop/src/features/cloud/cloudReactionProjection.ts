import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import {
  applyCloudReactionIntents,
  cloudReactionsEqual,
  normalizeCloudMessageReactions,
} from './cloudMessageMerge';

const cleanText = (value?: string | null) => (value ?? '').trim();
const contentRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export function patchCanonicalCloudMessages(
  current: CanonicalSessionState | null,
  groupRows: readonly IndexedCloudGroupRow[],
): CanonicalSessionState | null {
  if (!current || groupRows.length === 0) return current;
  const projections = new Map<string, {
    conversationId: string;
    targetMessageId: string;
    text: string;
    version: number | null;
    editedAt: string | null;
    reactions: NonNullable<CloudMessage['reactions']>;
    pendingReactionIntents: NonNullable<CloudMessage['pendingReactionIntents']>;
  }>();
  for (const row of groupRows) {
    const messageId = cleanText(row.envelope.message?.id);
    const conversationId = cleanText(row.wire.conversationId);
    const targetMessageId = cleanText(row.wire.messageId);
    if (!messageId || !conversationId || !targetMessageId) continue;
    const key = `${row.envelope.groupId}\u0000${messageId}`;
    const previous = projections.get(key);
    const version = row.wire.version ?? null;
    const useRowContent = !previous
      || (version ?? 0) > (previous.version ?? 0)
      || (
        version === previous.version
        && (row.wire.editedAt ?? '') >= (previous.editedAt ?? '')
      );
    const pendingReactionIntents = [
      ...(previous?.pendingReactionIntents ?? []),
      ...(row.wire.pendingReactionIntents ?? []),
    ];
    projections.set(key, {
      conversationId: useRowContent ? conversationId : previous.conversationId,
      targetMessageId: useRowContent ? targetMessageId : previous.targetMessageId,
      text: useRowContent ? row.envelope.message!.text : previous.text,
      version: useRowContent ? version : previous.version,
      editedAt: useRowContent ? row.wire.editedAt ?? null : previous.editedAt,
      reactions: applyCloudReactionIntents(
        normalizeCloudMessageReactions([
          ...(previous?.reactions ?? []),
          ...(row.wire.reactions ?? []),
        ]),
        pendingReactionIntents,
      ),
      pendingReactionIntents,
    });
  }
  if (projections.size === 0) return current;
  let changed = false;
  const messages = current.messages.map((message) => {
    const content = contentRecord(message.content);
    const cloudGroupMessageId = cleanText(
      typeof content.cloudGroupMessageId === 'string'
        ? content.cloudGroupMessageId
        : null,
    );
    const projection = projections.get(`${message.sessionId}\u0000${message.id}`)
      ?? projections.get(`${message.sessionId}\u0000${cloudGroupMessageId}`);
    if (!projection) return message;
    const reactions = normalizeCloudMessageReactions(content.reactions) ?? [];
    if (
      message.contentText === projection.text
      && content.cloudMessageVersion === projection.version
      && content.editedAt === projection.editedAt
      && content.cloudReactionConversationId === projection.conversationId
      && content.cloudReactionTargetMessageId === projection.targetMessageId
      && cloudReactionsEqual(reactions, projection.reactions)
    ) return message;
    changed = true;
    return {
      ...message,
      contentText: projection.text,
      contentHash: null,
      content: {
        ...content,
        cloudMessageVersion: projection.version,
        editedAt: projection.editedAt,
        cloudReactionConversationId: projection.conversationId,
        cloudReactionTargetMessageId: projection.targetMessageId,
        reactions: projection.reactions,
      },
    };
  });
  return changed ? { ...current, messages } : current;
}

export const patchCanonicalCloudReactions = patchCanonicalCloudMessages;
