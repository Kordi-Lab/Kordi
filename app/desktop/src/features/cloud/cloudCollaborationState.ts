import {
  COLLABORATION_MESSAGE_DIRECTION_INBOUND,
  COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/collaboration/messages';
import {
  cloudCollaborationConversationId,
  cloudConversationKindFromConversationId,
  cloudDirectPersonSessionId,
  cloudSystemAgentConversationId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  cloudSystemAgentSessionId,
  isCloudSystemAgentSessionId,
  isCloudCollaborationConversationId,
} from '@/features/collaboration/conversationIds';
import type {
  CanonicalSessionState,
  Contact,
  DesktopCollaborationConversation,
  DesktopCollaborationConversationMessage,
  DesktopCollaborationHost,
  DesktopCollaborationOutreachMetadata,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { formatDesktopClockTime, formatDesktopLastActiveLabel } from '@/lib/time';

import type { CloudAccount, CloudMessage } from './authClient';
import { buildCloudMessageIndex, type CloudMessageIndex } from './cloudMessageIndex';
import {
  cloudDirectPersonMessagesForPeer,
  cloudGroupControlMessageIds,
  cloudReadIdsRevision,
  cloudSelfAgentMessagesBySession,
  cloudTurnRevision,
} from './cloudCollaborationMemo';
import { cloudMessageAttachmentToMessageAttachment, cloudVoiceMessageToMessageVoice } from './cloudAttachments';
import { cloudMessageDeliveryPresentation } from './cloudMessageDeliveryPresentation';
import { cloudAvatarImageUrl } from './avatar';
import { canonicalAvatarImageSource } from './canonicalAvatar';
import {
  cloudGroupIdentityRequest,
  cloudGroupParticipantFromContact,
  cloudGroupSelfParticipant,
  isCloudGroupControlMessage,
  type CloudGroupReadCursor,
} from './cloudGroupMessages';
import {
  cloudMessageIsSelfAgentRequest,
  cloudMessageMentionsFirstPersonAgent,
  cloudMessageMentionsLocalAgent,
  cloudMessageMentionsNamedAgent,
  cloudDirectMessageIsUnreadForAccount,
  isCloudAgentControlMessage,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import { cloudAgentExecutionTurnForMessage } from './cloudAgentExecutionTrace';
import {
  cloudAgentBackgroundTurnForMessage,
  cloudAgentSyntheticResponseDirection,
  isDirectCloudContact,
} from './cloudCollaborationPresentation';
import { cleanCloudConversationTitle, cleanCloudSessionId } from './cloudConversationMetadata';
import {
  latestVisibleConversationMessage,
  selectVisibleCloudAgentResponses,
} from './cloudAgentResponseSelection';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
  cloudDirectMessageMentions,
  cloudDirectMessageTargetCloudAgentId,
  cloudDirectMessageTargetCloudAgentName,
  cloudDirectMessageTargetCloudAgentOwnerAccountId,
} from './cloudDirectMessages';
import { cloudAgentSessionTargetFromMessages } from './cloudSelfAgentSessionIdentity';
import { cloudMessageActionAllowsAgentTrigger } from './cloudAgentTriggerPolicy';
import { compareCloudMessages } from './cloudMessageMerge';
import {
  CLOUD_AGENT_RUNTIME,
  CLOUD_PERSON_RUNTIME,
  CLOUD_SERVER_LABEL,
  cloudAgentDisplayName,
  cloudContactToAgentPeer,
  cloudContactToPersonPeer,
  cloudPeerDisplayName,
  cloudSelfContact,
  isSystemCloudAgentContact,
} from './cloudContactPeers';
import {
  cloudConversationContactKey,
  messagesForCloudContact,
  systemAgentIdsByPeer,
} from './cloudSystemAgentConversations';
export const CLOUD_DIRECT_AGENT_OFFLINE_TIMEOUT_MS = 15_000;
const CLOUD_LOCAL_AGENT_PENDING_WINDOW_MS = 10 * 60_000;
const cloudConversationRevisionByObject = new WeakMap<DesktopCollaborationConversation, string>();
export function isCloudCollaborationHostId(hostId: string | null | undefined): boolean {
  return hostId === CLOUD_HOST_SENTINEL;
}
export function cloudSessionIdForCollaborationSend(localAccountId: string | null | undefined, peerAccountId: string | null | undefined, conversationId: string): string | null {
  const local = localAccountId?.trim() ?? '';
  const peer = peerAccountId?.trim() ?? '';
  const explicitSessionId = cloudSessionIdFromConversationId(conversationId);
  if (isCloudSystemAgentSessionId(explicitSessionId)) return explicitSessionId;
  if (local && peer && peer !== local) return cloudDirectPersonSessionId(local, peer);
  return explicitSessionId;
}

export function isCloudCollaborationState(state: DesktopCollaborationState | null | undefined): boolean {
  return Boolean(state?.hosts.some((host) => isCloudCollaborationHostId(host.id)));
}

export {
  cloudCollaborationConversationId,
  cloudConversationKindFromConversationId,
  cloudDirectPersonSessionId,
  cloudSystemAgentConversationId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  cloudSystemAgentSessionId,
  isCloudCollaborationConversationId,
};

export function cloudContactsToCanonicalIdentityRequests({
  account,
  contacts,
  localHumanIdentityId,
}: {
  account: CloudAccount;
  contacts: Contact[];
  localHumanIdentityId: string;
}): UpsertCanonicalIdentityRequest[] {
  const participants = [
    cloudGroupSelfParticipant(account, 'self'),
    ...contacts
      .map((contact) => cloudGroupParticipantFromContact(contact, 'person'))
      .filter((participant): participant is NonNullable<typeof participant> => Boolean(participant)),
  ];
  const seen = new Set<string>();
  const requests: UpsertCanonicalIdentityRequest[] = [];
  for (const participant of participants) {
    if (seen.has(participant.accountId)) continue;
    seen.add(participant.accountId);
    requests.push(cloudGroupIdentityRequest(participant, account, localHumanIdentityId));
  }
  return requests;
}

function cloudMessageIsGroupControl(message: CloudMessage, groupControlMessageIds?: ReadonlySet<string>) {
  return groupControlMessageIds
    ? groupControlMessageIds.has(message.messageId)
    : isCloudGroupControlMessage(message.body);
}

function cloudSelfAgentTitleFromMessages(
  messages: readonly CloudMessage[],
  groupControlMessageIds?: ReadonlySet<string>,
): string | null {
  for (const message of [...messages].sort(compareCloudMessages)) {
    if (message.messageKind === 'agent-model-change') continue;
    if (isCloudAgentControlMessage(message.body) || cloudMessageIsGroupControl(message, groupControlMessageIds) || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
    const title = cleanCloudConversationTitle(message.body.split(/\r?\n/, 1)[0]);
    if (title) return title.length > 80 ? `${title.slice(0, 77).trimEnd()}…` : title;
  }
  return null;
}

export function cloudMessageMentionsContactAgent(message: CloudMessage, contact: Contact | undefined): boolean {
  if (!contact) return false;
  return cloudMessageMentionsNamedAgent(message.body, cloudAgentDisplayName(contact))
    || cloudMessageMentionsNamedAgent(message.body, cloudPeerDisplayName(contact));
}

export function cloudMessageToCollaborationMessage(
  account: CloudAccount,
  message: CloudMessage,
  contact?: Contact,
  options: {
    cancelledRequestIds?: Set<string>;
    localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
    targetAgentNameByRequestId?: ReadonlyMap<string, string>;
  } = {},
): DesktopCollaborationConversationMessage {
  const timestampMs = Date.parse(message.createdAt) || Date.now();
  const agentResponse = parseCloudAgentResponse(message.body);
  const directMessageAction = agentResponse ? null : cloudDirectMessageAction(message.body);
  const displayText = agentResponse?.text ?? cloudDirectMessageDisplayText(message.body);
  const isOwn = message.fromAccountId === account.accountId;
  const syncedExecutionTurn = cloudAgentExecutionTurnForMessage(
    message,
    agentResponse,
  );
  const syncedBackgroundTurn = cloudAgentBackgroundTurnForMessage(
    message,
    agentResponse,
  );
  const displayBody = cloudDirectMessageDisplayText(message.body);
  const agentRequestId = !agentResponse && cloudMessageActionAllowsAgentTrigger(directMessageAction) && (
    Boolean(cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body))
    || cloudMessageMentionsLocalAgent(displayBody, account, { allowFirstPerson: isOwn })
    || cloudMessageMentionsContactAgent({ ...message, body: displayBody }, contact)
  )
    ? message.messageId
    : null;
  return {
    id: message.messageId,
    clientMessageId: message.clientMessageId ?? null,
    direction: agentResponse
      ? (isOwn ? COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE : COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE)
      : isOwn
        ? COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
        : COLLABORATION_MESSAGE_DIRECTION_INBOUND,
    sender: agentResponse ? options.targetAgentNameByRequestId?.get(agentResponse.requestId) ?? null : isOwn ? 'Me' : null,
    text: displayText,
    timeLabel: formatDesktopClockTime(timestampMs),
    timestampMs,
    requestId: agentResponse?.requestId ?? agentRequestId,
    ...cloudMessageDeliveryPresentation(
      message,
      contact,
      agentResponse?.deliveryState,
      options.cancelledRequestIds?.has(message.messageId) === true,
    ),
    detail: undefined,
    attachments: (message.attachments ?? []).map(cloudMessageAttachmentToMessageAttachment),
    mentions: agentResponse ? undefined : cloudDirectMessageMentions(message.body),
    messageAction: directMessageAction,
    messageKind: message.messageKind ?? null, voiceMessage: message.voiceMessage ? cloudVoiceMessageToMessageVoice(message.voiceMessage) : null, reactionConversationId: message.conversationId ?? null, reactionTargetMessageId: message.messageId, cloudMessageVersion: message.version ?? null, editedAt: message.editedAt ?? null, reactions: message.reactions ?? [],
    localTurn: agentResponse?.requestId
      ? options.localAgentTurnsByRequestId?.[agentResponse.requestId]
        ?? syncedExecutionTurn
        ?? syncedBackgroundTurn
      : null,
  };
}

function cloudAgentProcessingCollaborationMessage({
  account,
  request,
  targetAccountId,
  targetAgentName,
  localAgentTurnsByRequestId = {},
}: {
  account: CloudAccount;
  request: CloudMessage;
  targetAccountId: string;
  targetAgentName: string | null;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
}): DesktopCollaborationConversationMessage {
  const timestampMs = (Date.parse(request.createdAt) || Date.now()) + 1;
  return {
    id: `cloud-agent-processing:${request.messageId}`,
    direction: cloudAgentSyntheticResponseDirection(account, targetAccountId),
    sender: targetAgentName,
    text: 'processing...',
    timeLabel: formatDesktopClockTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: 'processing',
    detail: undefined,
    attachments: [],
    localTurn: localAgentTurnsByRequestId[request.messageId] ?? null,
  };
}

function cloudAgentCompletedLocalTurnCollaborationMessage({
  account,
  request,
  targetAccountId,
  targetAgentName,
  localTurn,
}: {
  account: CloudAccount;
  request: CloudMessage;
  targetAccountId: string;
  targetAgentName: string | null;
  localTurn: DesktopChatTurnSnapshot;
}): DesktopCollaborationConversationMessage {
  const requestCreatedAtMs = Date.parse(request.createdAt) || Date.parse(request.deliveredAt ?? '') || 0;
  const timestampMs = Math.max(
    requestCreatedAtMs + 1,
    localTurn.completedAtMs ?? localTurn.startedAtMs ?? requestCreatedAtMs + 1,
  );
  const assistantText = localTurn.assistantText.trim();
  const cancelled = localTurn.status === 'cancelled';
  const succeeded = localTurn.succeeded && assistantText.length > 0;
  const fallbackText = localTurn.error?.trim() || localTurn.message?.trim() || 'Cloud agent returned no text response';
  const text = succeeded
    ? assistantText
    : cancelled
      ? 'Request stopped.'
      : fallbackText;
  return {
    id: `cloud-agent-local-response:${request.messageId}`,
    direction: cloudAgentSyntheticResponseDirection(account, targetAccountId),
    sender: targetAgentName,
    text,
    timeLabel: formatDesktopClockTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: cancelled ? 'cancelled' : succeeded ? 'complete' : 'failed',
    detail: undefined,
    attachments: [],
    localTurn,
  };
}

function cloudAgentOfflineCollaborationMessage({
  account,
  request,
  targetAccountId,
  targetOwnerName,
  targetAgentName,
}: {
  account: CloudAccount;
  request: CloudMessage;
  targetAccountId: string;
  targetOwnerName: string;
  targetAgentName: string;
}): DesktopCollaborationConversationMessage {
  const requestCreatedAtMs = Date.parse(request.createdAt) || Date.parse(request.deliveredAt ?? '') || 0;
  const timestampMs = requestCreatedAtMs + CLOUD_DIRECT_AGENT_OFFLINE_TIMEOUT_MS;
  return {
    id: `cloud-agent-offline:${request.messageId}`,
    direction: cloudAgentSyntheticResponseDirection(account, targetAccountId),
    sender: null,
    text: `${targetOwnerName} and ${targetAgentName} are offline.`,
    timeLabel: formatDesktopClockTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: 'failed',
    detail: undefined,
    attachments: [],
    localTurn: null,
  };
}

function cloudAgentCancelledCollaborationMessage({
  account,
  request,
  cancel,
  targetAccountId,
}: {
  account: CloudAccount;
  request: CloudMessage;
  cancel: CloudMessage;
  targetAccountId: string;
}): DesktopCollaborationConversationMessage {
  const timestampMs = Date.parse(cancel.createdAt) || (Date.parse(request.createdAt) || Date.now()) + 1;
  const cancelledBy = cancel.fromAccountId === request.fromAccountId
    ? 'sender'
    : cancel.fromAccountId === targetAccountId
      ? 'agent owner'
      : 'participant';
  return {
    id: `cloud-agent-cancelled:${request.messageId}:${cancel.messageId}`,
    direction: cloudAgentSyntheticResponseDirection(account, targetAccountId),
    sender: null,
    text: `Request canceled by ${cancelledBy}.`,
    timeLabel: formatDesktopClockTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: 'cancelled',
    detail: undefined,
    attachments: [],
    localTurn: null,
  };
}

function cloudMessageIsAtOrBeforeReadCursor(message: CloudMessage, cursor?: CloudGroupReadCursor | null): boolean {
  if (!cursor) return false;
  const messageId = cleanCloudSessionId(message.messageId);
  const lastReadMessageId = cleanCloudSessionId(cursor.lastReadMessageId);
  if (messageId && lastReadMessageId && messageId === lastReadMessageId) return true;
  const lastReadCreatedAtMs = typeof cursor.lastReadCreatedAtMs === 'number' && Number.isFinite(cursor.lastReadCreatedAtMs)
    ? cursor.lastReadCreatedAtMs
    : null;
  if (lastReadCreatedAtMs === null) return false;
  const createdAtMs = Date.parse(message.createdAt);
  return Number.isFinite(createdAtMs) && createdAtMs <= lastReadCreatedAtMs;
}

export function buildCloudCollaborationHost(
  account: CloudAccount,
  contacts: Contact[],
  localAgentRuntimeRoute: DesktopChatMessageRoute | null = null,
  localAgentLabel = 'Kordi',
): DesktopCollaborationHost {
  const displayName = account.displayName?.trim() || account.primaryEmail?.trim() || 'Cloud user';
  const peers = contacts.filter(isDirectCloudContact).flatMap((contact) => (
    isSystemCloudAgentContact(contact)
      ? [cloudContactToAgentPeer(contact)]
      : [cloudContactToPersonPeer(contact), cloudContactToAgentPeer(contact)]
  ));
  const defaultAgentId = account.defaultAgent?.agentId?.trim() || `cloud-agent:${account.accountId}`;
  const defaultAgentName = localAgentLabel.trim() || account.defaultAgent?.displayName?.trim() || 'Kordi';
  const defaultAgentAvatarUrl = account.defaultAgent
    ? cloudAvatarImageUrl(canonicalAvatarImageSource(account.defaultAgent.avatar))
    : null;
  return {
    id: CLOUD_HOST_SENTINEL,
    registered: true,
    connected: true,
    serverUrl: CLOUD_SERVER_LABEL,
    nodeId: account.accountId,
    displayName,
    ownerName: displayName,
    endpoint: CLOUD_SERVER_LABEL,
    tokenPresent: true,
    humanId: account.accountId,
    discoveryMode: 'contacts',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    profileImageUrl: cloudAvatarImageUrl(canonicalAvatarImageSource(account.avatar)),
    activeAgentId: defaultAgentId,
    agents: [{
      id: defaultAgentId,
      label: defaultAgentName,
      nodeId: account.nodeId || account.accountId,
      runtime: CLOUD_AGENT_RUNTIME,
      isDefault: true,
      isActive: true,
      registered: true,
      defaultModel: localAgentRuntimeRoute?.model ?? null,
      defaultAuthProvider: localAgentRuntimeRoute?.authProvider ?? null,
      defaultAuthChoice: localAgentRuntimeRoute?.authChoice ?? null,
      fallbackModel: null,
      fallbackAuthProvider: null,
      fallbackAuthChoice: null,
      thinking: localAgentRuntimeRoute?.thinking ?? null,
      reachabilityPolicy: 'contacts',
      profileImageUrl: defaultAgentAvatarUrl,
    }],
    visiblePeers: peers,
    visiblePeerCount: peers.length,
    projects: [],
    contactRequests: [],
    lastError: null,
  };
}

function metadataAccountId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const accountId = (value as Record<string, unknown>).accountId;
  return typeof accountId === 'string' ? accountId.trim() : '';
}

function metadataText(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (value as Record<string, unknown>)[key];
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

export function cloudGroupParticipantContacts(input: {
  account: CloudAccount;
  canonicalSessionState: CanonicalSessionState | null | undefined;
  existingPeerIds: Iterable<string>;
}): Contact[] {
  const state = input.canonicalSessionState;
  if (!state) return [];
  const existingPeerIds = new Set([...input.existingPeerIds].map((peerId) => peerId.trim()).filter(Boolean));
  const groupSessionIds = new Set(state.sessions
    .filter((session) => session.kind === 'group')
    .map((session) => session.id));
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  const contacts: Contact[] = [];
  const seen = new Set<string>();

  for (const participant of state.participants) {
    if (!groupSessionIds.has(participant.sessionId) || participant.state === 'left') continue;
    const identity = identityById.get(participant.identityId);
    if (!identity || identity.kind !== 'human') continue;
    const accountId = (identity.humanId || identity.sourceIdentityId || metadataAccountId(identity.metadata)).trim();
    if (!accountId || accountId === input.account.accountId || existingPeerIds.has(accountId) || seen.has(accountId)) continue;
    if (identity.sourceHostId !== CLOUD_HOST_SENTINEL && !accountId.startsWith('acct_')) continue;
    seen.add(accountId);
    contacts.push({
      id: `cloud:${accountId}`,
      name: identity.displayName || accountId,
      initials: (identity.displayName || accountId).slice(0, 2).toUpperCase(),
      classType: 'other-users',
      entityType: 'user',
      subtitle: accountId,
      collaborationSources: [CLOUD_HOST_SENTINEL],
      status: 'online',
      discoverableOn: [CLOUD_HOST_SENTINEL],
      detail: accountId,
      owner: identity.displayName || accountId,
      sourceHostId: CLOUD_HOST_SENTINEL,
      sourceParticipantId: accountId,
      sourceRuntime: CLOUD_PERSON_RUNTIME,
      sourceHumanId: accountId,
      contactStatus: 'group-member',
      contactRequestDirection: null,
      avatarSeed: identity.avatarKey || accountId,
      profileImageUrl: identity.profileImageUrl ?? null,
      targetCloudAgentId: metadataText(identity.metadata, 'defaultAgentId') ?? `cloud-agent:${accountId}`,
      targetCloudAgentName: metadataText(identity.metadata, 'defaultAgentDisplayName') ?? 'Kordi',
      targetCloudAgentOwnerAccountId: accountId,
      targetCloudAgentOwnerName: identity.displayName || accountId,
      targetCloudAgentAvatarUrl: metadataText(identity.metadata, 'defaultAgentAvatarUrl'),
      targetCloudAgentAvatarSeed: metadataText(identity.metadata, 'defaultAgentAvatarSeed') ?? `cloud-agent:${accountId}`,
    });
  }

  return contacts;
}

export function buildCloudCollaborationConversation({
  account,
  contact,
  messages,
  runtime = CLOUD_PERSON_RUNTIME,
  readInboundMessageIds,
  readCursorsBySessionId = {},
  forceRead = false,
  localAgentTurnsByRequestId = {},
  cloudSessionId = null,
  cloudSessionTitle = null,
  groupControlMessageIds,
}: {
  account: CloudAccount;
  contact: Contact;
  messages: readonly CloudMessage[];
  runtime?: string;
  readInboundMessageIds?: Set<string>;
  readCursorsBySessionId?: Record<string, CloudGroupReadCursor | null | undefined>;
  forceRead?: boolean;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
  cloudSessionId?: string | null;
  cloudSessionTitle?: string | null;
  groupControlMessageIds?: ReadonlySet<string>;
}): DesktopCollaborationConversation {
  const peerAccountId = contact.sourceParticipantId || contact.id.replace(/^cloud:/, '');
  const isPerson = runtime.trim().toLowerCase() === CLOUD_PERSON_RUNTIME;
  const isSystemAgent = isSystemCloudAgentContact(contact);
  const isSelfPeer = !isSystemAgent && peerAccountId === account.accountId;
  const normalizedCloudSessionId = cleanCloudSessionId(cloudSessionId);
  const directPersonSessionId = isPerson && !isSelfPeer ? cloudDirectPersonSessionId(account.accountId, peerAccountId) : null;
  const readCursorSessionId = normalizedCloudSessionId ?? directPersonSessionId;
  const cancelMessageByRequestId = new Map<string, CloudMessage>();
  for (const message of messages) {
    const cancel = parseCloudAgentCancel(message.body);
    const requestId = cancel?.requestId.trim();
    if (requestId && !cancelMessageByRequestId.has(requestId)) {
      cancelMessageByRequestId.set(requestId, message);
    }
  }
  const cancelledRequestIds = new Set(cancelMessageByRequestId.keys());
  const sessionAgentTarget = isSelfPeer ? cloudAgentSessionTargetFromMessages(messages, account.accountId) : null;
  const defaultAgentId = account.defaultAgent?.agentId ?? `cloud-agent:${account.accountId}`;
  const defaultAgentName = account.defaultAgent?.displayName ?? 'Kordi';
  const selfAgentId = sessionAgentTarget?.targetCloudAgentId || defaultAgentId;
  const selfAgentName = sessionAgentTarget?.targetCloudAgentName || defaultAgentName;
  const requestTargetAccountIds = new Map<string, string>();
  const requestTargetAgentNames = new Map<string, string>();
  const explicitResponseAgentNames = new Map<string, string>();
  for (const message of messages) {
    if (cloudMessageIsGroupControl(message, groupControlMessageIds)) continue;
    if (parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
    if (!cloudMessageActionAllowsAgentTrigger(cloudDirectMessageAction(message.body))) continue;
    const displayBody = cloudDirectMessageDisplayText(message.body);
    const directTargetCloudAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
    const directTargetOwnerAccountId = directTargetCloudAgentId
      ? cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body)
      : null;
    if (!displayBody && directTargetCloudAgentId) continue;
    if (directTargetOwnerAccountId) {
      requestTargetAccountIds.set(message.messageId, directTargetOwnerAccountId);
      const directTargetAgentName = cloudDirectMessageTargetCloudAgentName(message.body)
        || (directTargetOwnerAccountId === account.accountId ? defaultAgentName : cloudAgentDisplayName(contact));
      requestTargetAgentNames.set(message.messageId, directTargetAgentName);
      explicitResponseAgentNames.set(message.messageId, directTargetAgentName);
    } else if (isSelfPeer && cloudMessageIsSelfAgentRequest({ ...message, body: displayBody }, account)) {
      requestTargetAccountIds.set(message.messageId, account.accountId);
      requestTargetAgentNames.set(message.messageId, selfAgentName);
    } else if (cloudMessageMentionsFirstPersonAgent(displayBody)) {
      requestTargetAccountIds.set(message.messageId, message.fromAccountId);
      requestTargetAgentNames.set(message.messageId, message.fromAccountId === account.accountId ? defaultAgentName : cloudAgentDisplayName(contact));
    } else if (cloudMessageMentionsContactAgent({ ...message, body: displayBody }, contact)) {
      requestTargetAccountIds.set(message.messageId, peerAccountId);
      requestTargetAgentNames.set(message.messageId, cloudAgentDisplayName(contact));
    } else if (cloudMessageMentionsLocalAgent(displayBody, account, { allowFirstPerson: false })) {
      requestTargetAccountIds.set(message.messageId, account.accountId);
      requestTargetAgentNames.set(message.messageId, defaultAgentName);
    }
  }
  const {
    visibleMessages: visibleCloudMessages,
    responseRequestIds, terminalResponseRequestIds,
  } = selectVisibleCloudAgentResponses(
    messages,
    requestTargetAccountIds,
    (message) => cloudMessageIsGroupControl(message, groupControlMessageIds),
    (requestId) => Boolean(localAgentTurnsByRequestId[requestId]?.completed),
  );
  const agentRequests = messages.filter((message) => {
    if (cloudMessageIsGroupControl(message, groupControlMessageIds)) return false;
    if (message.messageKind === 'agent-model-change') return false;
    if (parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) return false;
    return Boolean(requestTargetAccountIds.get(message.messageId));
  });
  const answeredRequestIds = new Set([...responseRequestIds, ...cancelledRequestIds]);
  // Remote Cloud agents remain reachable through server-side fallback while the
  // owner device is offline. Keep the request in the normal processing slot
  // until a Cloud/local agent response or cancel arrives instead of showing an
  // "offline" terminal failure.
  const timedOutAgentRequestIds = new Set<string>();
  const pendingAgentRequests = agentRequests.filter((message) => {
    if (answeredRequestIds.has(message.messageId) || timedOutAgentRequestIds.has(message.messageId)) return false;
    if (requestTargetAccountIds.get(message.messageId) !== account.accountId) return true;
    const localTurn = localAgentTurnsByRequestId[message.messageId];
    if (localTurn) return !localTurn.completed;
    if (cloudMessageMentionsFirstPersonAgent(message.body) || cloudMessageMentionsLocalAgent(message.body, account, { allowFirstPerson: message.fromAccountId === account.accountId })) return true;
    const createdAtMs = Date.parse(message.createdAt);
    return Number.isFinite(createdAtMs) && Date.now() - createdAtMs < CLOUD_LOCAL_AGENT_PENDING_WINDOW_MS;
  });
  const pendingAgentRequestIds = new Set(pendingAgentRequests.map((message) => message.messageId));
  const collaborationMessages = visibleCloudMessages.flatMap((message) => {
    const mapped = cloudMessageToCollaborationMessage(account, message, contact, { cancelledRequestIds, localAgentTurnsByRequestId, targetAgentNameByRequestId: explicitResponseAgentNames });
    const targetAccountId = requestTargetAccountIds.get(message.messageId);
    if (!targetAccountId) return [mapped];
    const localTurn = localAgentTurnsByRequestId[message.messageId] ?? null;
    if (localTurn?.completed && !terminalResponseRequestIds.has(message.messageId)) {
      return [mapped, cloudAgentCompletedLocalTurnCollaborationMessage({
        account,
        request: message,
        targetAccountId,
        targetAgentName: requestTargetAgentNames.get(message.messageId) ?? null,
        localTurn,
      })];
    }
    const cancel = cancelMessageByRequestId.get(message.messageId);
    if (cancel && !responseRequestIds.has(message.messageId)) {
      return [mapped, cloudAgentCancelledCollaborationMessage({
        account,
        request: message,
        cancel,
        targetAccountId,
      })];
    }
    if (timedOutAgentRequestIds.has(message.messageId)) {
      const targetOwnerName = targetAccountId === account.accountId
        ? (account.displayName || account.primaryEmail || 'Me')
        : cloudPeerDisplayName(contact);
      const targetAgentName = requestTargetAgentNames.get(message.messageId)
        || (targetAccountId === account.accountId ? defaultAgentName : cloudAgentDisplayName(contact));
      return [mapped, cloudAgentOfflineCollaborationMessage({
        account,
        request: message,
        targetAccountId,
        targetOwnerName,
        targetAgentName,
      })];
    }
    if (!pendingAgentRequestIds.has(message.messageId)) return [mapped];
    return [mapped, cloudAgentProcessingCollaborationMessage({
      account,
      request: message,
      targetAccountId,
      targetAgentName: requestTargetAgentNames.get(message.messageId) ?? null,
      localAgentTurnsByRequestId,
    })];
  });
  const title = isPerson
    ? cloudPeerDisplayName(contact)
    : isSelfPeer && normalizedCloudSessionId
      ? cleanCloudConversationTitle(cloudSessionTitle) ?? cloudSelfAgentTitleFromMessages(visibleCloudMessages, groupControlMessageIds) ?? defaultAgentName
      : isSelfPeer
        ? defaultAgentName
        : cloudAgentDisplayName(contact);
  const pendingAgentRequest = [...pendingAgentRequests].reverse()[0] ?? null;
  const last = latestVisibleConversationMessage(collaborationMessages);
  const updatedAtMs = last?.timestampMs ?? 0;
  const conversationId = cloudCollaborationConversationId(peerAccountId, runtime, normalizedCloudSessionId);
  const pendingAgentTargetsLocalAgent = pendingAgentRequest
    ? requestTargetAccountIds.get(pendingAgentRequest.messageId) === account.accountId
    : false;
  const pendingAgentOwnerName = pendingAgentTargetsLocalAgent
    ? (account.displayName || account.primaryEmail || 'Me')
    : cloudPeerDisplayName(contact);
  const pendingAgentDisplayName = pendingAgentRequest
    ? requestTargetAgentNames.get(pendingAgentRequest.messageId)
      || (pendingAgentTargetsLocalAgent ? defaultAgentName : cloudAgentDisplayName(contact))
    : pendingAgentTargetsLocalAgent
      ? defaultAgentName
      : cloudAgentDisplayName(contact);
  const pendingAgentId = pendingAgentTargetsLocalAgent
    ? defaultAgentId
    : contact.sourceAgentId?.trim() || `cloud-agent:${peerAccountId}`;
  const pendingAgentOutreach: DesktopCollaborationOutreachMetadata | null = pendingAgentRequest ? {
    targetKind: 'agent',
    parentSessionId: null,
    parentSessionTitle: null,
    parentSessionKind: null,
    parentGroupSpaceId: null,
    parentSessionParticipants: [],
    parentSessionMessages: [],
    initiatorIdentity: null,
    selfTargetIdentity: null,
    parentTurnId: null,
    parentMessageId: pendingAgentRequest.messageId,
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceConversationId: conversationId,
    sourceRequestId: pendingAgentRequest.messageId,
    targetNodeId: pendingAgentTargetsLocalAgent ? account.accountId : peerAccountId,
    targetHumanId: pendingAgentTargetsLocalAgent ? account.accountId : peerAccountId,
    targetAgentId: pendingAgentId,
    targetDisplayName: pendingAgentDisplayName,
    targetOwnerName: pendingAgentOwnerName,
    targetRuntime: CLOUD_AGENT_RUNTIME,
    requestText: promptTextForCloudAgentMention(cloudDirectMessageDisplayText(pendingAgentRequest.body)),
    triggerText: cloudDirectMessageDisplayText(pendingAgentRequest.body),
    contextText: null,
    contextPolicy: 'session-message',
    projectId: null,
    projectName: null,
    status: 'awaitingReply',
    deliveryState: 'processing',
    createdAtMs: Date.parse(pendingAgentRequest.createdAt) || Date.now(),
    updatedAtMs: Date.now(),
    completedAtMs: null,
    error: null,
    localTurn: localAgentTurnsByRequestId[pendingAgentRequest.messageId] ?? null,
  } : null;
  return {
    id: conversationId,
    supportTicketEnabled: Boolean(contact.supportTicketEnabled),
    canonicalSessionId: normalizedCloudSessionId ?? (isPerson && !isSelfPeer ? cloudDirectPersonSessionId(account.accountId, peerAccountId) : conversationId),
    hostId: CLOUD_HOST_SENTINEL,
    peerNodeId: peerAccountId,
    peerDisplayName: title,
    peerOwnerName: isSelfPeer
      ? (account.displayName || account.primaryEmail || 'Me')
      : contact.targetCloudAgentOwnerName?.trim() || cloudPeerDisplayName(contact),
    peerRuntime: runtime,
    projectId: null,
    projectName: null,
    title,
    subtitle: last?.text || (isPerson ? 'Person chat' : 'Remote agent chat'),
    unreadCount: forceRead
      ? 0
      : visibleCloudMessages.filter((message) => (
          cloudDirectMessageIsUnreadForAccount(message, account.accountId)
          && !readInboundMessageIds?.has(message.messageId)
          && !cloudMessageIsAtOrBeforeReadCursor(message, readCursorSessionId ? readCursorsBySessionId[readCursorSessionId] : null)
        )).length,
    updatedAtMs,
    updatedAtLabel: last ? formatDesktopLastActiveLabel(updatedAtMs) : '',
    awaitingReply: Boolean(pendingAgentOutreach),
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: pendingAgentOutreach,
    identity: {
      sourceHostId: CLOUD_HOST_SENTINEL,
      localHumanId: account.accountId,
      localHumanName: account.displayName || account.primaryEmail || 'Me',
      localAgentId: isSelfPeer ? selfAgentId : contact.sourceAgentId?.trim() || `cloud-agent:${peerAccountId}`,
      localAgentName: isSelfPeer ? selfAgentName : cloudAgentDisplayName(contact),
      localAgentNodeId: account.nodeId || account.accountId,
      remoteHumanId: peerAccountId,
      remoteHumanName: isSelfPeer
        ? (account.displayName || account.primaryEmail || 'Me')
        : contact.targetCloudAgentOwnerName?.trim() || cloudPeerDisplayName(contact),
      remoteHumanNodeId: peerAccountId,
      remoteAgentId: isSelfPeer ? selfAgentId : contact.sourceAgentId?.trim() || `cloud-agent:${peerAccountId}`,
      remoteAgentName: isSelfPeer ? selfAgentName : cloudAgentDisplayName(contact),
      remoteAgentNodeId: peerAccountId,
      remoteAgentRuntime: CLOUD_AGENT_RUNTIME,
    },
    messages: collaborationMessages,
  };
}

export function buildCloudDesktopCollaborationState({
  account,
  contacts,
  messagesByPeer = {},
  messageIndex,
  previousState = null,
  readInboundMessageIdsByPeer = {},
  readCursorsBySessionId = {},
  activeConversationId,
  localAgentTurnsByRequestId = {},
  localAgentRuntimeRoute = null,
  localAgentLabel = 'Kordi',
  cloudSessionTitlesById = {},
  hiddenCloudSessionIds = new Set<string>(),
  suppressUnscopedSelfAgentConversation = false,
}: {
  account: CloudAccount;
  contacts: Contact[];
  messagesByPeer?: Record<string, CloudMessage[]>;
  messageIndex?: CloudMessageIndex;
  previousState?: DesktopCollaborationState | null;
  readInboundMessageIdsByPeer?: Record<string, Set<string>>;
  readCursorsBySessionId?: Record<string, CloudGroupReadCursor | null | undefined>;
  activeConversationId?: string | null;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
  localAgentRuntimeRoute?: DesktopChatMessageRoute | null;
  localAgentLabel?: string | null;
  cloudSessionTitlesById?: Record<string, string | null | undefined>;
  hiddenCloudSessionIds?: ReadonlySet<string>;
  suppressUnscopedSelfAgentConversation?: boolean;
}): DesktopCollaborationState {
  const index = messageIndex ?? buildCloudMessageIndex(account.accountId, messagesByPeer);
  const groupControlMessageIds = cloudGroupControlMessageIds(index);
  const previousConversationById = new Map((previousState?.conversations ?? []).map((conversation) => [conversation.id, conversation]));
  const reuseConversation = (
    conversationId: string,
    revision: string,
    build: () => DesktopCollaborationConversation,
  ) => {
    const previous = previousConversationById.get(conversationId);
    if (previous && cloudConversationRevisionByObject.get(previous) === revision) return previous;
    const next = build();
    cloudConversationRevisionByObject.set(next, revision);
    return next;
  };
  const conversationRevision = ({
    baseRevision,
    cloudSessionId,
    contact,
    forceRead,
    messages,
    runtime,
    title,
  }: {
    baseRevision: string;
    cloudSessionId?: string | null;
    contact: Contact;
    forceRead: boolean;
    messages: readonly CloudMessage[];
    runtime: string;
    title?: string | null;
  }) => {
    const readCursorSessionId = cleanCloudSessionId(cloudSessionId)
      ?? (runtime === CLOUD_PERSON_RUNTIME
        ? cloudDirectPersonSessionId(account.accountId, contact.sourceParticipantId || contact.id.replace(/^cloud:/, ''))
        : null);
    const readCursor = readCursorSessionId ? readCursorsBySessionId[readCursorSessionId] : null;
    const readIds = readInboundMessageIdsByPeer[contact.sourceParticipantId || contact.id.replace(/^cloud:/, '')];
    return [
      baseRevision,
      account.accountId,
      account.displayName ?? '',
      account.primaryEmail,
      account.nodeId ?? '',
      canonicalAvatarImageSource(account.avatar) ?? '',
      runtime,
      cleanCloudSessionId(cloudSessionId) ?? '',
      forceRead ? 'read' : 'unread',
      contact.name,
      contact.owner,
      contact.systemContact ? 'system' : 'contact',
      contact.supportTicketEnabled ? 'support-ticket' : '',
      contact.sourceAgentId ?? '',
      contact.profileImageUrl ?? '',
      contact.avatarSeed ?? '',
      title ?? '',
      readCursor?.lastReadMessageId ?? '',
      readCursor?.lastReadCreatedAtMs ?? '',
      readIds ? cloudReadIdsRevision(readIds) : '',
      cloudTurnRevision(messages, localAgentTurnsByRequestId),
    ].join('\u0000');
  };
  const directContacts = contacts.filter(isDirectCloudContact);
  const host = buildCloudCollaborationHost(account, directContacts, localAgentRuntimeRoute, localAgentLabel ?? 'Kordi');
  const systemAgentIds = systemAgentIdsByPeer(directContacts);
  const activePeerId = activeConversationId ? cloudPeerAccountIdFromConversationId(activeConversationId) : null;
  const conversationContacts = [cloudSelfContact(account), ...directContacts]
    .filter((contact, index, list) => {
      const contactKey = cloudConversationContactKey(contact);
      return list.findIndex((candidate) => cloudConversationContactKey(candidate) === contactKey) === index;
    });
  const conversations = conversationContacts
    .flatMap((contact) => {
      const peerId = contact.sourceParticipantId || contact.id.replace(/^cloud:/, '');
      const peerMessages = messagesByPeer[peerId] ?? index.byPeerId.get(peerId) ?? [];
      const isSystemAgent = isSystemCloudAgentContact(contact);
      const messages = messagesForCloudContact(
        contact,
        peerMessages,
        systemAgentIds.get(peerId) ?? new Set(),
      );
      const hasMessages = messages.length > 0;
      const isActivePeer = isSystemAgent ? activeConversationId === cloudSystemAgentConversationId(account.accountId, peerId, contact.sourceAgentId ?? '') : peerId === activePeerId;
      const isSelfPeer = peerId === account.accountId;
      if (!hasMessages && !isActivePeer) return [];

      const directPersonMessages = isSelfPeer || isSystemAgent
        ? []
        : cloudDirectPersonMessagesForPeer(account, peerId, messages);
      const personConversation = !isSelfPeer && !isSystemAgent
        ? [reuseConversation(
            cloudCollaborationConversationId(peerId, CLOUD_PERSON_RUNTIME),
            conversationRevision({
              baseRevision: index.peerRevisionByPeerId.get(peerId) ?? '0::',
              contact,
              forceRead: isActivePeer,
              messages: directPersonMessages,
              runtime: CLOUD_PERSON_RUNTIME,
            }),
            () => buildCloudCollaborationConversation({
              account,
              contact,
              messages: directPersonMessages,
              runtime: CLOUD_PERSON_RUNTIME,
              readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
              readCursorsBySessionId,
              forceRead: isActivePeer,
              localAgentTurnsByRequestId,
              groupControlMessageIds,
            }),
          )]
        : [];
      const activeCloudSessionId = activeConversationId ? cloudSessionIdFromConversationId(activeConversationId) : null;
      const agentConversation = (() => {
        if (isSystemAgent) {
          const cloudSessionId = cloudSystemAgentSessionId(account.accountId, contact.sourceAgentId ?? '');
          const conversationId = cloudCollaborationConversationId(peerId, CLOUD_AGENT_RUNTIME, cloudSessionId);
          const forceRead = activeConversationId === conversationId;
          return [reuseConversation(
            conversationId,
            conversationRevision({
              baseRevision: index.peerRevisionByPeerId.get(peerId) ?? '0::',
              cloudSessionId,
              contact,
              forceRead,
              messages,
              runtime: CLOUD_AGENT_RUNTIME,
            }),
            () => buildCloudCollaborationConversation({
              account,
              contact,
              messages,
              runtime: CLOUD_AGENT_RUNTIME,
              readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
              readCursorsBySessionId,
              forceRead,
              localAgentTurnsByRequestId,
              cloudSessionId,
              groupControlMessageIds,
            }),
          )];
        }
        if (isSelfPeer && hasMessages) {
          const { hasSessionScopedMessages, messagesBySessionId } = cloudSelfAgentMessagesBySession(messages);
          return [...messagesBySessionId.entries()].flatMap(([cloudSessionId, sessionMessages]) => {
            if (cloudSessionId?.startsWith('draft:')) return [];
            if (cloudSessionId && hiddenCloudSessionIds.has(cloudSessionId)) return [];
            if ((hasSessionScopedMessages || suppressUnscopedSelfAgentConversation) && !cloudSessionId) return [];
            const forceRead = isActivePeer && (!activeCloudSessionId || activeCloudSessionId === cloudSessionId);
            const cloudSessionTitle = cloudSessionId ? cloudSessionTitlesById[cloudSessionId] : null;
            const conversationId = cloudCollaborationConversationId(peerId, CLOUD_AGENT_RUNTIME, cloudSessionId);
            return [reuseConversation(
              conversationId,
              conversationRevision({
                baseRevision: cloudSessionId
                  ? index.sessionRevisionBySessionId.get(cloudSessionId) ?? '0::'
                  : index.peerRevisionByPeerId.get(peerId) ?? '0::',
                cloudSessionId,
                contact,
                forceRead,
                messages: sessionMessages,
                runtime: CLOUD_AGENT_RUNTIME,
                title: cloudSessionTitle,
              }),
              () => buildCloudCollaborationConversation({
                account,
                contact,
                messages: sessionMessages,
                runtime: CLOUD_AGENT_RUNTIME,
                readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
                readCursorsBySessionId,
                forceRead,
                localAgentTurnsByRequestId,
                cloudSessionId,
                cloudSessionTitle,
                groupControlMessageIds,
              }),
            )];
          });
        }
        return [];
      })();
      return [...personConversation, ...agentConversation];
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return {
    activeHostId: CLOUD_HOST_SENTINEL,
    hosts: [host],
    conversations,
    localAgentRouting: null,
  };
}
