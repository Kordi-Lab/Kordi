import { cleanCloudText as cleanText, cloudObjectContent as contentRecord } from './cloudValue';
import { currentCloudGroupReplyRevisions } from '@/features/canonical/cloudGroupReplyRevisions';
import { canApplyCloudAgentTurnTransition } from '@/features/canonical/cloudAgentTurnLifecycle';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import {
  applyCloudReactionIntents,
  cloudReactionsEqual,
  normalizeCloudMessageReactions,
} from './cloudMessageMerge';

function transcriptionKey(value: unknown) {
  const state = contentRecord(value);
  return [state.status, state.sourceVersion, state.engine, state.attempts, state.language].join('\u0000');
}

export function patchCanonicalCloudMessages(
  current: CanonicalSessionState | null,
  groupRows: readonly IndexedCloudGroupRow[],
): CanonicalSessionState | null {
  if (!current) return current;
  const revisions = currentCloudGroupReplyRevisions(current.messages);
  if (revisions !== current.messages) current = { ...current, messages: revisions };
  if (groupRows.length === 0) return current;
  const projections = new Map<string, {
    conversationId: string;
    targetMessageId: string;
    text: string;
    deliveryState: string | null;
    voiceMessage: Record<string, unknown> | null;
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
    const rowVoice = row.envelope.message?.voiceMessage;
    const voiceMessage = rowVoice?.mediaId ? { ...rowVoice, mediaId: rowVoice.mediaId } : null;
    const pendingReactionIntents = [
      ...(previous?.pendingReactionIntents ?? []),
      ...(row.wire.pendingReactionIntents ?? []),
    ];
    projections.set(key, {
      conversationId: useRowContent ? conversationId : previous.conversationId,
      targetMessageId: useRowContent ? targetMessageId : previous.targetMessageId,
      text: useRowContent ? row.envelope.message!.text : previous.text,
      deliveryState: useRowContent ? row.envelope.message?.deliveryState ?? null : previous.deliveryState,
      voiceMessage: useRowContent ? voiceMessage : previous.voiceMessage,
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
    // Agent turns retain their original waiting-slot ID after completion.
    // Only the current wire message may supply edits, text, and reactions.
    const projection = projections.get(
      `${message.sessionId}\u0000${cloudGroupMessageId || message.id}`,
    );
    if (!projection) return message;
    if (typeof content.cloudMessageVersion === 'number'
      && content.cloudMessageVersion > (projection.version ?? 0)) return message;
    const deliveryState = message.messageKind === 'agent-turn' ? projection.deliveryState : null;
    const status = deliveryState === 'complete' ? 'received' : deliveryState ?? message.status;
    const text = deliveryState === 'failed' ? '' : projection.text;
    if (deliveryState && !canApplyCloudAgentTurnTransition(message, {
      ...message, status, content: { ...content, deliveryState },
    })) return message;
    const reactions = normalizeCloudMessageReactions(content.reactions) ?? [];
    // A sender's transcript update changes only the voice metadata; keep this device's local path.
    const currentVoice = contentRecord(content.voiceMessage);
    const voiceMessage = projection.voiceMessage && currentVoice.mediaId === projection.voiceMessage.mediaId
      ? { ...currentVoice, transcript: projection.voiceMessage.transcript, transcription: projection.voiceMessage.transcription }
      : null;
    const voiceChanged = Boolean(voiceMessage) && (
      currentVoice.transcript !== voiceMessage?.transcript
      || transcriptionKey(currentVoice.transcription) !== transcriptionKey(voiceMessage?.transcription)
    );
    if (
      !voiceChanged
      && message.status === status
      && (!deliveryState || content.deliveryState === deliveryState)
      && message.contentText === text
      && content.cloudMessageVersion === projection.version
      && content.editedAt === projection.editedAt
      && content.cloudReactionConversationId === projection.conversationId
      && content.cloudReactionTargetMessageId === projection.targetMessageId
      && cloudReactionsEqual(reactions, projection.reactions)
    ) return message;
    changed = true;
    return {
      ...message,
      contentText: text,
      status,
      contentHash: null,
      content: {
        ...content,
        ...(deliveryState ? { deliveryState } : {}),
        ...(deliveryState === 'failed' ? { error: projection.text } : {}),
        cloudMessageVersion: projection.version,
        editedAt: projection.editedAt,
        cloudReactionConversationId: projection.conversationId,
        cloudReactionTargetMessageId: projection.targetMessageId,
        reactions: projection.reactions,
        ...(voiceChanged && voiceMessage ? { voiceMessage } : {}),
      },
    };
  });
  return changed ? { ...current, messages } : current;
}

export const patchCanonicalCloudReactions = patchCanonicalCloudMessages;
