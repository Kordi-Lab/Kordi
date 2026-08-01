import type { Contact } from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAgentRunClaimInput,
  CloudMessage,
} from './authClient';
import {
  cloudDirectPersonSessionId,
  cloudMessageMentionsContactAgent,
} from './cloudCollaborationState';
import {
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
  cloudDirectMessageTargetCloudAgentOwnerAccountId,
} from './cloudDirectMessages';
import {
  cloudMessageActionAllowsAgentContext,
  cloudMessageActionAllowsAgentTrigger,
} from './cloudAgentTriggerPolicy';
import {
  cloudGroupAgentHandoffTargetsAccount,
} from './cloudGroupMentions';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';
import {
  buildCloudMessageIndex,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import { isCloudAgentProcessingPlaceholderText } from './cloudAgentRequestState';

const MAX_CLOUD_FALLBACK_HISTORY_MESSAGES = 12;

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function cloudContactPeerAccountId(contact: Contact): string {
  return contact.sourceParticipantId?.trim()
    || contact.id.replace(/^cloud:/, '').trim();
}

function cloudFallbackHistoryParticipantName(
  contact: Contact | undefined,
  ownerAccountId: string,
): string {
  return contact?.name?.trim() || ownerAccountId.trim() || 'Peer';
}

function cloudFallbackHistoryLine({
  account,
  contact,
  isGroupControl,
  message,
  ownerAccountId,
}: {
  account: CloudAccount;
  contact: Contact | undefined;
  isGroupControl: boolean;
  message: CloudMessage;
  ownerAccountId: string;
}): string | null {
  if (isGroupControl || parseCloudAgentCancel(message.body)) return null;
  if (
    !cloudMessageActionAllowsAgentContext(
      cloudDirectMessageAction(message.body),
    )
  ) return null;
  const agentResponse = parseCloudAgentResponse(message.body);
  const displayBody = cloudDirectMessageDisplayText(message.body);
  const text = agentResponse?.text
    ?? (
      message.fromAccountId === account.accountId
      && cloudMessageMentionsContactAgent(
        { ...message, body: displayBody },
        contact,
      )
        ? promptTextForCloudAgentMention(displayBody)
        : displayBody
    );
  const normalizedText = text.trim();
  if (!normalizedText) return null;
  const peerName = cloudFallbackHistoryParticipantName(
    contact,
    ownerAccountId,
  );
  const label = agentResponse
    ? `${peerName}'s Kordi`
    : message.fromAccountId === account.accountId
      ? 'Me'
      : peerName;
  return `${label}: ${normalizedText}`;
}

function cloudFallbackRunPromptForMessage({
  account,
  contact,
  message,
  ownerAccountId,
  peerMessages,
  groupControlMessageIds,
}: {
  account: CloudAccount;
  contact: Contact | undefined;
  message: CloudMessage;
  ownerAccountId: string;
  peerMessages: readonly CloudMessage[];
  groupControlMessageIds: ReadonlySet<string>;
}): string {
  const currentPrompt = promptTextForCloudAgentMention(
    cloudDirectMessageDisplayText(message.body),
  );
  const requestIndex = peerMessages.findIndex(
    (candidate) => candidate.messageId === message.messageId,
  );
  const previousMessages = (
    requestIndex >= 0 ? peerMessages.slice(0, requestIndex) : peerMessages
  ).filter((candidate) => candidate.messageId !== message.messageId);
  const history = previousMessages
    .map((candidate) => cloudFallbackHistoryLine({
      account,
      contact,
      isGroupControl: groupControlMessageIds.has(candidate.messageId),
      message: candidate,
      ownerAccountId,
    }))
    .filter((line): line is string => Boolean(line))
    .slice(-MAX_CLOUD_FALLBACK_HISTORY_MESSAGES);
  if (history.length === 0) return currentPrompt;
  return `Conversation history:\n${history.join('\n')}`
    + `\n\nCurrent request:\n${currentPrompt}`;
}

function cloudGroupFallbackHistoryLine(
  envelope: CloudGroupControlEnvelope,
): string | null {
  if (envelope.kind !== 'group-message' || !envelope.message) return null;
  const message = envelope.message;
  if (!cloudMessageActionAllowsAgentContext(message.messageAction)) return null;
  if (
    message.deliveryState === 'processing'
    || isCloudAgentProcessingPlaceholderText(message.text)
  ) return null;
  const text = message.senderKind === 'agent'
    ? message.text.trim()
    : promptTextForCloudAgentMention(message.text).trim();
  if (!text) return null;
  const participantName = envelope.participants.find(
    (participant) => participant.accountId === message.senderAccountId,
  )?.displayName?.trim();
  const label = message.senderDisplayName?.trim()
    || (
      message.senderKind === 'agent' && participantName
        ? `${participantName}'s Kordi`
        : participantName
    )
    || 'Cloud participant';
  return `${label}: ${text}`;
}

function cloudGroupFallbackRunPromptForMessage({
  groupRows,
  groupId,
  requestMessageId,
  requestCreatedAtMs,
  requestText,
}: {
  groupRows: readonly IndexedCloudGroupRow[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
  requestText: string;
}): string {
  const currentPrompt = promptTextForCloudAgentMention(requestText);
  const seenMessageIds = new Set<string>();
  const history = groupRows
    .flatMap(({ envelope }) => {
      if (
        envelope?.kind !== 'group-message'
        || envelope.groupId !== groupId
        || !envelope.message
      ) return [];
      if (envelope.message.id === requestMessageId) return [];
      if (envelope.message.createdAtMs > requestCreatedAtMs) return [];
      if (envelope.message.forkSnapshot === true) return [];
      if (!cloudMessageActionAllowsAgentContext(envelope.message.messageAction)) {
        return [];
      }
      if (seenMessageIds.has(envelope.message.id)) return [];
      seenMessageIds.add(envelope.message.id);
      const line = cloudGroupFallbackHistoryLine(envelope);
      return line ? [line] : [];
    })
    .slice(-MAX_CLOUD_FALLBACK_HISTORY_MESSAGES);
  if (history.length === 0) return currentPrompt;
  return `Group chat history:\n${history.join('\n')}`
    + `\n\nCurrent request:\n${currentPrompt}`;
}

export function cloudFallbackRunClaimsForMessages({
  account,
  contacts,
  messageIndex,
  messagesByPeer = {},
}: {
  account: CloudAccount;
  contacts: Contact[];
  messageIndex?: CloudMessageIndex;
  messagesByPeer?: Record<string, CloudMessage[]>;
}): CloudAgentRunClaimInput[] {
  const index = messageIndex
    ?? buildCloudMessageIndex(account.accountId, messagesByPeer);
  const contactByPeerId = new Map(
    contacts.map((contact) => [cloudContactPeerAccountId(contact), contact]),
  );
  const claims: CloudAgentRunClaimInput[] = [];
  const groupRowByWireMessageId = index.groupRowByWireMessageId;
  const groupControlMessageIds = new Set(groupRowByWireMessageId.keys());
  const terminalGroupResponseKeys = new Set<string>();
  for (const { envelope } of index.groupRows) {
    const groupMessage = envelope.kind === 'group-message'
      ? envelope.message
      : null;
    if (
      !groupMessage
      || groupMessage.senderKind !== 'agent'
      || groupMessage.deliveryState === 'processing'
    ) continue;
    const linkedRequestId = cleanText(groupMessage.requestId)
      || cleanText(groupMessage.replyToMessageId);
    if (linkedRequestId) {
      terminalGroupResponseKeys.add(
        `${envelope.groupId}\u0000${groupMessage.senderAccountId}`
        + `\u0000${linkedRequestId}`,
      );
    }
  }
  const terminalDirectRequestIdsByPeerId = new Map<string, Set<string>>();
  for (const [peerId, peerMessages] of index.byPeerId) {
    const requestIds = new Set<string>();
    for (const message of peerMessages) {
      if (groupControlMessageIds.has(message.messageId)) continue;
      const requestId = parseCloudAgentCancel(message.body)?.requestId
        || parseCloudAgentResponse(message.body)?.requestId;
      if (requestId) requestIds.add(requestId);
    }
    terminalDirectRequestIdsByPeerId.set(peerId, requestIds);
  }

  for (const [peerId, peerMessages] of index.byPeerId) {
    const ownerAccountId = peerId.trim();
    if (!ownerAccountId || ownerAccountId === account.accountId) continue;
    const contact = contactByPeerId.get(ownerAccountId);
    for (const message of peerMessages) {
      if (
        message.fromAccountId !== account.accountId
        || message.toAccountId !== ownerAccountId
      ) continue;
      const groupEnvelope =
        groupRowByWireMessageId.get(message.messageId)?.envelope;
      if (
        groupEnvelope?.kind === 'group-message'
        && groupEnvelope.message?.senderAccountId === account.accountId
      ) {
        const groupMessage = groupEnvelope.message;
        if (!cloudMessageActionAllowsAgentTrigger(groupMessage.messageAction)) {
          continue;
        }
        if (
          groupMessage.senderKind === 'agent'
          && !cloudGroupAgentHandoffTargetsAccount(
            groupEnvelope,
            ownerAccountId,
          )
        ) continue;
        const groupRequestMessage = { ...message, body: groupMessage.text };
        if (!cloudMessageMentionsContactAgent(groupRequestMessage, contact)) {
          continue;
        }
        const alreadyTerminal = terminalGroupResponseKeys.has(
          `${groupEnvelope.groupId}\u0000${ownerAccountId}`
          + `\u0000${groupMessage.id}`,
        );
        if (alreadyTerminal) continue;
        claims.push({
          requestMessageId: groupMessage.id,
          sessionId: groupEnvelope.groupId,
          ownerAccountId,
          requesterAccountId: account.accountId,
          prompt: cloudGroupFallbackRunPromptForMessage({
            groupRows: index.groupRows,
            groupId: groupEnvelope.groupId,
            requestMessageId: groupMessage.id,
            requestCreatedAtMs: groupMessage.createdAtMs,
            requestText: groupMessage.text,
          }),
          idempotencyKey:
            `cloud-agent-fallback-group:${groupEnvelope.groupId}`
            + `:${groupMessage.id}:${ownerAccountId}`,
        });
        continue;
      }
      if (
        groupEnvelope
        || parseCloudAgentResponse(message.body)
        || parseCloudAgentCancel(message.body)
      ) continue;
      if (
        !cloudMessageActionAllowsAgentTrigger(
          cloudDirectMessageAction(message.body),
        )
      ) continue;
      const targetCloudAgentId =
        cloudDirectMessageTargetCloudAgentId(message.body);
      const targetsHostedCloudAgent = targetCloudAgentId
        && cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body)
          === ownerAccountId;
      if (
        !targetsHostedCloudAgent
        && !cloudMessageMentionsContactAgent(message, contact)
      ) continue;
      const alreadyTerminal =
        terminalDirectRequestIdsByPeerId.get(peerId)?.has(message.messageId)
          === true;
      if (alreadyTerminal) continue;
      claims.push({
        requestMessageId: message.messageId,
        sessionId: message.sessionId?.trim()
          || cloudDirectPersonSessionId(account.accountId, ownerAccountId),
        ownerAccountId,
        requesterAccountId: account.accountId,
        prompt: cloudFallbackRunPromptForMessage({
          account,
          contact,
          message,
          ownerAccountId,
          peerMessages,
          groupControlMessageIds,
        }),
        idempotencyKey:
          `cloud-agent-fallback:${message.messageId}:${ownerAccountId}`,
        ...(targetCloudAgentId ? { targetCloudAgentId } : {}),
      });
    }
  }

  return claims;
}
