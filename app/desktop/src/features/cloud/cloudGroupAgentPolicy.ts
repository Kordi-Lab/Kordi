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
  cloudGroupAgentMentionDepth,
  cloudGroupMentionInstruction,
} from './cloudGroupMentions';
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
  const targetsOwnedHostedCloudAgent = Boolean(
    cleanCloudText(message.targetCloudAgentId)
      .startsWith('cloud_agent_')
    && cleanCloudText(message.targetCloudAgentOwnerAccountId)
      === account.accountId,
  );
  return targetsOwnedHostedCloudAgent || cloudMessageMentionsLocalAgent(
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
}: {
  groupRows: readonly IndexedCloudGroupRow[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
  respondingAccountId: string;
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
  );
  const requestEnvelope = groupRows.find(({ envelope }) => (
    envelope?.kind === 'group-message'
      && envelope.groupId === groupId
      && envelope.message?.id === requestMessageId
  ))?.envelope ?? null;
  const mentionInstruction = requestEnvelope?.message
    ? cloudGroupMentionInstruction({
      participants: requestEnvelope.participants,
      respondingAccountId,
      allowAgentMentions:
        cloudGroupAgentMentionDepth(requestEnvelope.message)
          < CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH,
      requesterAccountId: requestEnvelope.message.senderAccountId,
      requesterKind: requestEnvelope.message.senderKind === 'agent'
        ? 'agent'
        : 'human',
    })
    : null;
  if (!mentionInstruction) return history;
  return compactCloudAgentNativeContextMessages([
    ...history,
    {
      id: `cloud-group-mention-permissions:${groupId}:${cloudContextFingerprint(mentionInstruction)}`,
      authorName: 'Group mention permissions',
      authorKind: 'agent',
      text: mentionInstruction,
      createdAtMs: requestCreatedAtMs,
    },
  ]);
}

function cloudContextFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
