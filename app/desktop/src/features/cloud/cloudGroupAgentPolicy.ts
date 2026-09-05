import type { DesktopChatContextMessage } from '@/lib/desktop';
import type { CloudAccount } from './authClient';
import {
  compactCloudAgentNativeContextMessages,
  cloudMessageMentionsLocalAgent,
} from './cloudAgentMessages';
import { isCloudAgentProcessingPlaceholderText } from './cloudAgentRequestState';
import {
  cloudMessageActionAllowsAgentContext,
  cloudMessageActionAllowsAgentTrigger,
} from './cloudAgentTriggerPolicy';
import {
  CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH,
  cloudGroupAgentHandoffTargetsAccount,
  cloudGroupAgentPersonaInstruction,
  cloudGroupAgentMentionDepth,
  cloudGroupMentionInstruction,
} from './cloudGroupMentions';
import { cloudAgentId, defaultCloudAgentId } from './cloudAgentIdentity';
import type {
  CloudGroupControlEnvelope,
  CloudGroupParticipant,
} from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { cleanCloudText } from './cloudValue';

export function cloudGroupMessageTargetsLocalAgent(
  message: NonNullable<CloudGroupControlEnvelope['message']>,
  account: CloudAccount,
  participants: readonly CloudGroupParticipant[] = [],
): boolean {
  if (
    message.forkSnapshot === true
    || !cloudMessageActionAllowsAgentTrigger(message.messageAction)
  ) return false;
  if (message.senderKind === 'agent') {
    return cloudGroupAgentHandoffTargetsAccount(
      { message, participants: [...participants] },
      account.accountId,
    );
  }
  const targetCloudAgentId = cleanCloudText(message.targetCloudAgentId);
  const targetsOwnedCloudAgent = Boolean(
    (
      targetCloudAgentId.startsWith('cloud_agent_')
      || targetCloudAgentId === defaultCloudAgentId(account.accountId)
    )
    && cleanCloudText(message.targetCloudAgentOwnerAccountId)
      === account.accountId,
  );
  return targetsOwnedCloudAgent || cloudMessageMentionsLocalAgent(
    message.text,
    account,
    {
      allowFirstPerson:
        message.senderAccountId === account.accountId,
    },
  );
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
  const history = compactCloudAgentNativeContextMessages(
    groupRows.flatMap(({ envelope }) => {
      if (
        envelope?.kind !== 'group-message'
        || envelope.groupId !== groupId
        || !envelope.message
      ) return [];
      const message = envelope.message;
      if (message.id === requestMessageId) return [];
      if (message.createdAtMs > requestCreatedAtMs) return [];
      if (message.forkSnapshot === true) return [];
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
