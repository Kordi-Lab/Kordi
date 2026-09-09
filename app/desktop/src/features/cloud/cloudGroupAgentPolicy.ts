import type { DesktopChatContextMessage } from '@/lib/desktop';
import type { CloudAccount } from './authClient';
import {
  compactCloudAgentNativeContextMessages,
} from './cloudAgentMessages';
import { isCloudAgentProcessingPlaceholderText } from './cloudAgentRequestState';
import {
  cloudMessageActionAllowsAgentContext,
  cloudMessageActionAllowsAgentTrigger,
  cloudAgentContextMessageIds,
} from './cloudAgentTriggerPolicy';
import {
  CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH,
  cloudGroupAgentHandoffTargetsAccount,
  cloudGroupAgentPersonaInstruction,
  cloudGroupAgentMentionDepth,
  cloudGroupMentionInstruction,
} from './cloudGroupMentions';
import { cloudAgentId } from './cloudAgentIdentity';
import type {
  CloudGroupControlEnvelope,
  CloudGroupParticipant,
} from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { cloudGroupHumanAgentTarget } from './cloudGroupAgentTarget';
import type { MessageActionMetadata } from '@/kordi-app/types/message';

export function cloudGroupAgentReplyThreadAction(
  rows: readonly IndexedCloudGroupRow[], groupId: string, requestId: string, ownerAccountId: string,
): MessageActionMetadata | null {
  for (const { envelope, wire } of [...rows].reverse()) {
    const message = envelope.message;
    if (envelope.groupId !== groupId || !message || wire.fromAccountId !== ownerAccountId
      || message.senderAccountId !== ownerAccountId || message.senderKind !== 'agent'
      || (message.requestId ?? message.replyToMessageId) !== requestId) continue;
    const action = message.messageAction;
    if (action?.kind === 'thread' && action.source.sourceSessionId === groupId) return action;
  }
  return null;
}

export function cloudGroupMessageTargetsLocalAgent(
  message: NonNullable<CloudGroupControlEnvelope['message']>,
  account: CloudAccount,
  participants: readonly CloudGroupParticipant[] = [],
): boolean {
  if (!cloudMessageActionAllowsAgentTrigger(message.messageAction)) return false;
  if (message.senderKind === 'agent') {
    return cloudGroupAgentHandoffTargetsAccount(
      { message, participants: [...participants] },
      account.accountId,
    );
  }
  return cloudGroupHumanAgentTarget(message, participants)?.ownerAccountId === account.accountId;
}

export function cloudGroupAgentContextMessageIds(groupRows: readonly IndexedCloudGroupRow[], groupId: string, requestId: string, ownerAccountId?: string): Set<string> {
  return cloudAgentContextMessageIds(groupRows.flatMap(({ envelope }) => (
    envelope?.kind === 'group-message' && envelope.groupId === groupId && envelope.message
      ? [{ ...envelope.message, replyToMessageId: envelope.message.replyToMessageId ?? envelope.message.requestId }]
      : []
  )), requestId, ownerAccountId ? cloudGroupAgentReplyThreadAction(groupRows, groupId, requestId, ownerAccountId) : null);
}

export function cloudGroupNativeContextMessages({
  groupRows,
  groupId,
  requestMessageId,
  requestCreatedAtMs,
  respondingAccountId,
  respondingAgentId,
}: {
  groupRows: readonly IndexedCloudGroupRow[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
  respondingAccountId: string;
  respondingAgentId?: string | null;
}): DesktopChatContextMessage[] {
  const contextIds = cloudGroupAgentContextMessageIds(groupRows, groupId, requestMessageId, respondingAccountId);
  const history = compactCloudAgentNativeContextMessages(
    groupRows.flatMap(({ envelope }) => {
      if (
        envelope?.kind !== 'group-message'
        || envelope.groupId !== groupId
        || !envelope.message
      ) return [];
      const message = envelope.message;
      if (!contextIds.has(message.id)) return [];
      if (message.id === requestMessageId) return [];
      if (message.createdAtMs > requestCreatedAtMs) return [];
      if (
        !cloudMessageActionAllowsAgentContext(message.messageAction)
      ) return [];
      if (
        message.deliveryState === 'processing'
        || isCloudAgentProcessingPlaceholderText(message.text)
      ) return [];
      const text = message.text.trim();
      if (!text) return [];
      const participantName = envelope.participants.find(
        (participant) =>
          participant.accountId === message.senderAccountId,
      )?.displayName?.trim();
      return [{
        id: message.id,
        authorName:
          message.senderDisplayName?.trim()
          || participantName
          || 'Cloud participant',
        authorKind:
          message.senderKind === 'agent' ? 'agent' : 'human',
        text,
        createdAtMs: message.createdAtMs,
      }];
    }),
  ).slice(-8).map((message) => ({ ...message, text: Array.from(message.text).slice(0, 800).join('') }));
  const requestEnvelope = groupRows.find(({ envelope }) => (
    envelope?.kind === 'group-message'
      && envelope.groupId === groupId
      && envelope.message?.id === requestMessageId
  ))?.envelope ?? null;
  const mentionInstruction = requestEnvelope?.message
    ? cloudGroupMentionInstruction({
      participants: requestEnvelope.participants,
      respondingAccountId,
      respondingAgentId: cloudAgentId(
        respondingAgentId ?? requestEnvelope.message.targetCloudAgentId,
        respondingAccountId,
      ),
      allowAgentMentions:
        cloudGroupAgentMentionDepth(requestEnvelope.message)
          < CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH,
      requesterAccountId: requestEnvelope.message.senderAccountId,
      requesterKind: requestEnvelope.message.senderKind === 'agent'
        ? 'agent'
        : 'human',
    })
    : null;
  if (!requestEnvelope?.message) return history;
  const allowAgentMentions = cloudGroupAgentMentionDepth(
    requestEnvelope.message,
  ) < CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH;
  const personaInstruction = cloudGroupAgentPersonaInstruction({
    respondingAgentDisplayName: requestEnvelope.message.targetCloudAgentName,
    respondingAccountId,
    respondingAgentId: cloudAgentId(
      respondingAgentId ?? requestEnvelope.message.targetCloudAgentId,
      respondingAccountId,
    ),
    requesterAccountId: requestEnvelope.message.senderAccountId,
    requesterKind: requestEnvelope.message.senderKind === 'agent'
      ? 'agent'
      : 'human',
    allowAgentMentions,
  });
  return compactCloudAgentNativeContextMessages([
    ...history,
    {
      id: `cloud-group-persona:${groupId}:${cloudContextFingerprint(personaInstruction)}`,
      authorName: 'Group agent identity',
      authorKind: 'agent',
      contextRole: 'system',
      text: `${personaInstruction}\nCurrent request author: ${JSON.stringify({
        accountId: requestEnvelope.message.senderAccountId,
        kind: requestEnvelope.message.senderKind === 'agent' ? 'agent' : 'human',
        name: requestEnvelope.message.senderDisplayName
          || requestEnvelope.participants.find((participant) => participant.accountId === requestEnvelope.message?.senderAccountId)?.displayName
          || 'Group participant',
      })}. Interpret I/me/my as this author; the group creator is not necessarily the requester.`,
      createdAtMs: requestCreatedAtMs,
    },
    ...(mentionInstruction ? [{
      id: `cloud-group-mention-permissions:${groupId}:${cloudContextFingerprint(mentionInstruction)}`,
      authorName: 'Group mention directory',
      authorKind: 'agent' as const,
      contextRole: 'resource' as const,
      text: mentionInstruction,
      createdAtMs: requestCreatedAtMs,
    }] : []),
  ]);
}

function cloudContextFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
