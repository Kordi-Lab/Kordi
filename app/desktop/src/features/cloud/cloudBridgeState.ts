import {
  BRIDGE_MESSAGE_DIRECTION_INBOUND,
  BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/bridge/messages';
import type {
  CanonicalSessionState,
  Contact,
  DesktopBridgeConversation,
  DesktopBridgeConversationMessage,
  DesktopBridgeHost,
  DesktopBridgeOutreachMetadata,
  DesktopBridgePeer,
  DesktopBridgeState,
  DesktopChatTurnSnapshot,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';

import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { formatDesktopClockTime, formatDesktopLastActiveLabel } from '@/lib/time';

import type { CloudAccount, CloudMessage } from './authClient';
import { cloudMessageAttachmentToMessageAttachment } from './cloudAttachments';
import { cloudAvatarImageUrl } from './avatar';
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
  isCloudAgentControlMessage,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import { CLOUD_HOST_SENTINEL } from './useCloudContacts';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
  cloudDirectMessageTargetCloudAgentName,
  cloudDirectMessageTargetCloudAgentOwnerAccountId,
} from './cloudDirectMessages';

const CLOUD_SERVER_LABEL = 'kordi.cloud';
export const CLOUD_DIRECT_AGENT_OFFLINE_TIMEOUT_MS = 15_000;
const CLOUD_LOCAL_AGENT_PENDING_WINDOW_MS = 10 * 60_000;
const CLOUD_PERSON_RUNTIME = 'person';
const CLOUD_AGENT_RUNTIME = 'kordi-desktop';
const CLOUD_AGENT_SESSION_SUFFIX = ':session:';

export function isCloudBridgeHostId(hostId: string | null | undefined): boolean {
  return hostId === CLOUD_HOST_SENTINEL;
}

export function cloudBridgeConversationId(peerAccountId: string, runtime: string = CLOUD_PERSON_RUNTIME, sessionId?: string | null): string {
  const suffix = runtime.trim().toLowerCase() === CLOUD_PERSON_RUNTIME ? ':person' : '';
  const base = `bridge:${CLOUD_HOST_SENTINEL}:${peerAccountId}${suffix}`;
  const trimmedSessionId = sessionId?.trim();
  return trimmedSessionId ? `${base}${CLOUD_AGENT_SESSION_SUFFIX}${encodeURIComponent(trimmedSessionId)}` : base;
}

export function cloudDirectPersonSessionId(localAccountId: string, peerAccountId: string): string {
  return `session:direct-person:${[localAccountId.trim(), peerAccountId.trim()].filter(Boolean).sort().join(':')}`;
}

export function cloudPeerAccountIdFromConversationId(conversationId: string): string | null {
  const prefix = `bridge:${CLOUD_HOST_SENTINEL}:`;
  if (!conversationId.startsWith(prefix)) return null;
  let rest = conversationId.slice(prefix.length);
  const sessionSuffixIndex = rest.indexOf(CLOUD_AGENT_SESSION_SUFFIX);
  if (sessionSuffixIndex >= 0) rest = rest.slice(0, sessionSuffixIndex);
  if (!rest) return null;
  return rest.endsWith(':person') ? rest.slice(0, -':person'.length) : rest;
}

export function cloudSessionIdFromConversationId(conversationId: string): string | null {
  const prefix = `bridge:${CLOUD_HOST_SENTINEL}:`;
  if (!conversationId.startsWith(prefix)) return null;
  const sessionSuffixIndex = conversationId.indexOf(CLOUD_AGENT_SESSION_SUFFIX, prefix.length);
  if (sessionSuffixIndex < 0) return null;
  const encoded = conversationId.slice(sessionSuffixIndex + CLOUD_AGENT_SESSION_SUFFIX.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded).trim() || null;
  } catch {
    return null;
  }
}

export function cloudSessionIdForBridgeSend(localAccountId: string | null | undefined, peerAccountId: string | null | undefined, conversationId: string): string | null {
  const local = localAccountId?.trim() ?? '';
  const peer = peerAccountId?.trim() ?? '';
  if (local && peer && peer !== local) return cloudDirectPersonSessionId(local, peer);
  return cloudSessionIdFromConversationId(conversationId);
}

export function isCloudBridgeConversationId(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && cloudPeerAccountIdFromConversationId(conversationId));
}

export function isCloudBridgeState(state: DesktopBridgeState | null | undefined): boolean {
  return Boolean(state?.hosts.some((host) => isCloudBridgeHostId(host.id)));
}

export function cloudPeerDisplayName(contact: Contact): string {
  return contact.name?.trim() || contact.bridgePeerNodeId?.trim() || contact.id.replace(/^cloud:/, '');
}

export function cloudAgentDisplayName(contact: Contact): string {
  const owner = cloudPeerDisplayName(contact);
  return `${owner}'s Kordi`;
}

export function cloudContactToPersonPeer(contact: Contact): DesktopBridgePeer {
  const accountId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
  const displayName = cloudPeerDisplayName(contact);
  return {
    nodeId: accountId,
    displayName,
    runtime: CLOUD_PERSON_RUNTIME,
    endpoint: CLOUD_SERVER_LABEL,
    ownerName: contact.owner || displayName,
    createdAt: null,
    sharedProjects: [],
    humanId: accountId,
    agentId: null,
    isDefaultAgent: false,
    discoveryMode: 'contacts',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    agentReachabilityPolicy: 'contacts',
    isContact: true,
    contactRequestStatus: 'accepted',
    contactRequestDirection: 'outgoing',
    profileImageUrl: contact.profileImageUrl,
    avatarSeed: contact.avatarSeed ?? accountId,
  };
}

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

export function cloudContactToAgentPeer(contact: Contact): DesktopBridgePeer {
  const accountId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
  const ownerName = cloudPeerDisplayName(contact);
  return {
    nodeId: accountId,
    displayName: cloudAgentDisplayName(contact),
    runtime: CLOUD_AGENT_RUNTIME,
    endpoint: CLOUD_SERVER_LABEL,
    ownerName,
    createdAt: null,
    sharedProjects: [],
    humanId: accountId,
    agentId: `cloud-agent:${accountId}`,
    isDefaultAgent: true,
    discoveryMode: 'contacts',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    agentReachabilityPolicy: 'contacts',
    isContact: true,
    contactRequestStatus: 'accepted',
    contactRequestDirection: 'outgoing',
    profileImageUrl: contact.profileImageUrl,
    avatarSeed: contact.avatarSeed ?? accountId,
  };
}

function cleanCloudSessionId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function cleanCloudConversationTitle(value?: string | null): string | null {
  const title = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (!title || /^(#\s*)?(my kordi|new session|untitled session)$/i.test(title)) return null;
  return title;
}

function cloudSelfAgentTitleFromMessages(messages: CloudMessage[]): string | null {
  for (const message of [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    if (isCloudAgentControlMessage(message.body) || isCloudGroupControlMessage(message.body) || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
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

export function cloudMessageToBridgeMessage(
  account: CloudAccount,
  message: CloudMessage,
  contact?: Contact,
  options: {
    cancelledRequestIds?: Set<string>;
    localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
    targetAgentNameByRequestId?: ReadonlyMap<string, string>;
  } = {},
): DesktopBridgeConversationMessage {
  const timestampMs = Date.parse(message.createdAt) || Date.now();
  const agentResponse = parseCloudAgentResponse(message.body);
  const directMessageAction = agentResponse ? null : cloudDirectMessageAction(message.body);
  const displayText = agentResponse?.text ?? cloudDirectMessageDisplayText(message.body);
  const isOwn = message.fromAccountId === account.accountId;
  const displayBody = cloudDirectMessageDisplayText(message.body);
  const agentRequestId = !agentResponse && (
    Boolean(cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body))
    || cloudMessageMentionsLocalAgent(displayBody, account, { allowFirstPerson: isOwn })
    || cloudMessageMentionsContactAgent({ ...message, body: displayBody }, contact)
  )
    ? message.messageId
    : null;
  return {
    id: message.messageId,
    direction: agentResponse
      ? (isOwn ? BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE : BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE)
      : isOwn
        ? BRIDGE_MESSAGE_DIRECTION_OUTBOUND
        : BRIDGE_MESSAGE_DIRECTION_INBOUND,
    sender: agentResponse ? options.targetAgentNameByRequestId?.get(agentResponse.requestId) ?? null : isOwn ? 'Me' : null,
    text: displayText,
    timeLabel: formatCloudBridgeTime(timestampMs),
    timestampMs,
    requestId: agentResponse?.requestId ?? agentRequestId,
    deliveryState: agentResponse?.deliveryState === 'failed'
      ? 'failed'
      : options.cancelledRequestIds?.has(message.messageId)
        ? 'cancelled'
        : message.direction === 'outgoing'
          ? (message.readAt ? 'read' : 'delivered')
          : agentResponse?.deliveryState === 'complete'
            ? 'complete'
            : null,
    detail: undefined,
    attachments: (message.attachments ?? []).map(cloudMessageAttachmentToMessageAttachment),
    messageAction: directMessageAction,
    localTurn: agentResponse?.requestId ? options.localAgentTurnsByRequestId?.[agentResponse.requestId] ?? null : null,
  };
}

function cloudAgentSyntheticResponseDirection(account: CloudAccount, targetAccountId: string) {
  return targetAccountId === account.accountId
    ? BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
    : BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE;
}

function cloudAgentProcessingBridgeMessage({
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
}): DesktopBridgeConversationMessage {
  const timestampMs = (Date.parse(request.createdAt) || Date.now()) + 1;
  return {
    id: `cloud-agent-processing:${request.messageId}`,
    direction: cloudAgentSyntheticResponseDirection(account, targetAccountId),
    sender: targetAgentName,
    text: 'processing...',
    timeLabel: formatCloudBridgeTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: 'processing',
    detail: undefined,
    attachments: [],
    localTurn: localAgentTurnsByRequestId[request.messageId] ?? null,
  };
}

function cloudAgentCompletedLocalTurnBridgeMessage({
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
}): DesktopBridgeConversationMessage {
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
    timeLabel: formatCloudBridgeTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: cancelled ? 'cancelled' : succeeded ? 'complete' : 'failed',
    detail: undefined,
    attachments: [],
    localTurn,
  };
}

function cloudAgentOfflineBridgeMessage({
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
}): DesktopBridgeConversationMessage {
  const requestCreatedAtMs = Date.parse(request.createdAt) || Date.parse(request.deliveredAt ?? '') || 0;
  const timestampMs = requestCreatedAtMs + CLOUD_DIRECT_AGENT_OFFLINE_TIMEOUT_MS;
  return {
    id: `cloud-agent-offline:${request.messageId}`,
    direction: cloudAgentSyntheticResponseDirection(account, targetAccountId),
    sender: null,
    text: `${targetOwnerName} and ${targetAgentName} are offline.`,
    timeLabel: formatCloudBridgeTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: 'failed',
    detail: undefined,
    attachments: [],
    localTurn: null,
  };
}

function cloudAgentCancelledBridgeMessage({
  account,
  request,
  cancel,
  targetAccountId,
}: {
  account: CloudAccount;
  request: CloudMessage;
  cancel: CloudMessage;
  targetAccountId: string;
}): DesktopBridgeConversationMessage {
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
    timeLabel: formatCloudBridgeTime(timestampMs),
    timestampMs,
    requestId: request.messageId,
    deliveryState: 'cancelled',
    detail: undefined,
    attachments: [],
    localTurn: null,
  };
}

function isDirectCloudContact(contact: Contact): boolean {
  return contact.bridgeContactStatus?.trim().toLowerCase() !== 'group-member';
}

function cloudDirectPersonMessagesForPeer(
  account: CloudAccount,
  peerAccountId: string,
  messages: CloudMessage[],
): CloudMessage[] {
  const directSessionId = cloudDirectPersonSessionId(account.accountId, peerAccountId);
  return messages.filter((message) => {
    const sessionId = cleanCloudSessionId(message.sessionId);
    return !sessionId || sessionId === directSessionId;
  });
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

export function buildCloudBridgeHost(
  account: CloudAccount,
  contacts: Contact[],
  localAgentRuntimeRoute: DesktopChatMessageRoute | null = null,
): DesktopBridgeHost {
  const displayName = account.displayName?.trim() || account.primaryEmail?.trim() || 'Cloud user';
  const peers = contacts.filter(isDirectCloudContact).flatMap((contact) => [
    cloudContactToPersonPeer(contact),
    cloudContactToAgentPeer(contact),
  ]);
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
    profileImageUrl: cloudAvatarImageUrl(account.avatarUrl),
    activeAgentId: 'cloud-local-agent',
    agents: [{
      id: 'cloud-local-agent',
      label: 'Kordi',
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
      profileImageUrl: cloudAvatarImageUrl(account.avatarUrl),
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
    const accountId = (identity.humanId || identity.bridgeNodeId || metadataAccountId(identity.metadata)).trim();
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
      bridges: [CLOUD_HOST_SENTINEL],
      status: 'online',
      discoverableOn: [CLOUD_HOST_SENTINEL],
      detail: accountId,
      owner: identity.displayName || accountId,
      bridgeHostId: CLOUD_HOST_SENTINEL,
      bridgePeerNodeId: accountId,
      bridgePeerRuntime: CLOUD_PERSON_RUNTIME,
      bridgeHumanId: accountId,
      bridgeContactStatus: 'group-member',
      bridgeContactRequestDirection: null,
      avatarSeed: identity.avatarKey || accountId,
      profileImageUrl: identity.profileImageUrl ?? null,
    });
  }

  return contacts;
}

export function buildCloudBridgeConversation({
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
}: {
  account: CloudAccount;
  contact: Contact;
  messages: CloudMessage[];
  runtime?: string;
  readInboundMessageIds?: Set<string>;
  readCursorsBySessionId?: Record<string, CloudGroupReadCursor | null | undefined>;
  forceRead?: boolean;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
  cloudSessionId?: string | null;
  cloudSessionTitle?: string | null;
}): DesktopBridgeConversation {
  const peerAccountId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
  const isPerson = runtime.trim().toLowerCase() === CLOUD_PERSON_RUNTIME;
  const isSelfPeer = peerAccountId === account.accountId;
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
  const requestTargetAccountIds = new Map<string, string>();
  const requestTargetAgentNames = new Map<string, string>();
  const explicitResponseAgentNames = new Map<string, string>();
  for (const message of messages) {
    if (parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
    const displayBody = cloudDirectMessageDisplayText(message.body);
    const directTargetCloudAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
    const directTargetOwnerAccountId = directTargetCloudAgentId
      ? cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body)
      : null;
    if (directTargetOwnerAccountId) {
      requestTargetAccountIds.set(message.messageId, directTargetOwnerAccountId);
      const directTargetAgentName = cloudDirectMessageTargetCloudAgentName(message.body)
        || (directTargetOwnerAccountId === account.accountId ? 'My Kordi' : cloudAgentDisplayName(contact));
      requestTargetAgentNames.set(message.messageId, directTargetAgentName);
      explicitResponseAgentNames.set(message.messageId, directTargetAgentName);
    } else if (isSelfPeer && cloudMessageIsSelfAgentRequest({ ...message, body: displayBody }, account)) {
      requestTargetAccountIds.set(message.messageId, account.accountId);
      requestTargetAgentNames.set(message.messageId, 'My Kordi');
    } else if (cloudMessageMentionsFirstPersonAgent(displayBody)) {
      requestTargetAccountIds.set(message.messageId, message.fromAccountId);
      requestTargetAgentNames.set(message.messageId, message.fromAccountId === account.accountId ? 'My Kordi' : cloudAgentDisplayName(contact));
    } else if (cloudMessageMentionsContactAgent({ ...message, body: displayBody }, contact)) {
      requestTargetAccountIds.set(message.messageId, peerAccountId);
      requestTargetAgentNames.set(message.messageId, cloudAgentDisplayName(contact));
    } else if (cloudMessageMentionsLocalAgent(displayBody, account, { allowFirstPerson: false })) {
      requestTargetAccountIds.set(message.messageId, account.accountId);
      requestTargetAgentNames.set(message.messageId, 'My Kordi');
    }
  }
  const visibleResponseKeys = new Set<string>();
  const visibleCloudMessages = messages.filter((message) => {
    if (isCloudAgentControlMessage(message.body) || isCloudGroupControlMessage(message.body)) return false;
    const response = parseCloudAgentResponse(message.body);
    if (!response) return true;
    const expectedResponderAccountId = requestTargetAccountIds.get(response.requestId);
    if (expectedResponderAccountId && message.fromAccountId !== expectedResponderAccountId) return false;
    const responderAccountId = expectedResponderAccountId || message.fromAccountId;
    const responseKey = `${response.requestId}:${responderAccountId}`;
    if (visibleResponseKeys.has(responseKey)) return false;
    visibleResponseKeys.add(responseKey);
    return true;
  });
  const agentRequests = messages.filter((message) => {
    if (parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) return false;
    return Boolean(requestTargetAccountIds.get(message.messageId));
  });
  const responseRequestIds = new Set(messages
    .map((message) => parseCloudAgentResponse(message.body)?.requestId)
    .filter((value): value is string => Boolean(value)));
  const answeredRequestIds = new Set(responseRequestIds);
  for (const requestId of cancelledRequestIds) answeredRequestIds.add(requestId);
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
  const bridgeMessages = visibleCloudMessages.flatMap((message) => {
    const mapped = cloudMessageToBridgeMessage(account, message, contact, { cancelledRequestIds, localAgentTurnsByRequestId, targetAgentNameByRequestId: explicitResponseAgentNames });
    const targetAccountId = requestTargetAccountIds.get(message.messageId);
    if (!targetAccountId) return [mapped];
    const localTurn = localAgentTurnsByRequestId[message.messageId] ?? null;
    if (localTurn?.completed && !answeredRequestIds.has(message.messageId)) {
      return [mapped, cloudAgentCompletedLocalTurnBridgeMessage({
        account,
        request: message,
        targetAccountId,
        targetAgentName: requestTargetAgentNames.get(message.messageId) ?? null,
        localTurn,
      })];
    }
    const cancel = cancelMessageByRequestId.get(message.messageId);
    if (cancel && !responseRequestIds.has(message.messageId)) {
      return [mapped, cloudAgentCancelledBridgeMessage({
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
        || (targetAccountId === account.accountId ? 'My Kordi' : cloudAgentDisplayName(contact));
      return [mapped, cloudAgentOfflineBridgeMessage({
        account,
        request: message,
        targetAccountId,
        targetOwnerName,
        targetAgentName,
      })];
    }
    if (!pendingAgentRequestIds.has(message.messageId)) return [mapped];
    return [mapped, cloudAgentProcessingBridgeMessage({
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
      ? cleanCloudConversationTitle(cloudSessionTitle) ?? cloudSelfAgentTitleFromMessages(visibleCloudMessages) ?? 'My Kordi'
      : isSelfPeer
        ? 'My Kordi'
        : cloudAgentDisplayName(contact);
  const pendingAgentRequest = [...pendingAgentRequests].reverse()[0] ?? null;
  const last = bridgeMessages[bridgeMessages.length - 1] ?? null;
  const updatedAtMs = last?.timestampMs ?? Date.now();
  const conversationId = cloudBridgeConversationId(peerAccountId, runtime, normalizedCloudSessionId);
  const pendingAgentTargetsLocalAgent = pendingAgentRequest
    ? requestTargetAccountIds.get(pendingAgentRequest.messageId) === account.accountId
    : false;
  const pendingAgentOwnerName = pendingAgentTargetsLocalAgent
    ? (account.displayName || account.primaryEmail || 'Me')
    : cloudPeerDisplayName(contact);
  const pendingAgentDisplayName = pendingAgentRequest
    ? requestTargetAgentNames.get(pendingAgentRequest.messageId)
      || (pendingAgentTargetsLocalAgent ? 'My Kordi' : cloudAgentDisplayName(contact))
    : pendingAgentTargetsLocalAgent
      ? 'My Kordi'
      : cloudAgentDisplayName(contact);
  const pendingAgentId = pendingAgentTargetsLocalAgent
    ? 'cloud-local-agent'
    : `cloud-agent:${peerAccountId}`;
  const pendingAgentOutreach: DesktopBridgeOutreachMetadata | null = pendingAgentRequest ? {
    targetKind: 'bridge-agent',
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
    bridgeHostId: CLOUD_HOST_SENTINEL,
    bridgeConversationId: conversationId,
    bridgeRequestId: pendingAgentRequest.messageId,
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
    canonicalSessionId: normalizedCloudSessionId ?? (isPerson && !isSelfPeer ? cloudDirectPersonSessionId(account.accountId, peerAccountId) : conversationId),
    hostId: CLOUD_HOST_SENTINEL,
    peerNodeId: peerAccountId,
    peerDisplayName: title,
    peerOwnerName: isSelfPeer ? (account.displayName || account.primaryEmail || 'Me') : cloudPeerDisplayName(contact),
    peerRuntime: runtime,
    projectId: null,
    projectName: null,
    title,
    subtitle: last?.text || (isPerson ? 'Direct human chat' : 'Remote agent thread'),
    unreadCount: forceRead
      ? 0
      : visibleCloudMessages.filter((message) => (
          message.toAccountId === account.accountId
          && message.fromAccountId !== account.accountId
          && !message.readAt
          && !readInboundMessageIds?.has(message.messageId)
          && !cloudMessageIsAtOrBeforeReadCursor(message, readCursorSessionId ? readCursorsBySessionId[readCursorSessionId] : null)
        )).length,
    updatedAtMs,
    updatedAtLabel: formatDesktopLastActiveLabel(updatedAtMs),
    awaitingReply: Boolean(pendingAgentOutreach),
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: pendingAgentOutreach,
    identity: {
      bridgeHostId: CLOUD_HOST_SENTINEL,
      localHumanId: account.accountId,
      localHumanName: account.displayName || account.primaryEmail || 'Me',
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      localAgentNodeId: account.nodeId || account.accountId,
      remoteHumanId: peerAccountId,
      remoteHumanName: isSelfPeer ? (account.displayName || account.primaryEmail || 'Me') : cloudPeerDisplayName(contact),
      remoteHumanNodeId: peerAccountId,
      remoteAgentId: isSelfPeer ? 'cloud-local-agent' : `cloud-agent:${peerAccountId}`,
      remoteAgentName: isSelfPeer ? 'My Kordi' : cloudAgentDisplayName(contact),
      remoteAgentNodeId: peerAccountId,
      remoteAgentRuntime: CLOUD_AGENT_RUNTIME,
    },
    messages: bridgeMessages,
  };
}

function cloudSelfContact(account: CloudAccount): Contact {
  const displayName = account.displayName?.trim() || account.primaryEmail?.trim() || 'Me';
  return {
    id: `cloud:${account.accountId}`,
    name: displayName,
    initials: displayName.slice(0, 2).toUpperCase(),
    classType: 'my-agents',
    entityType: 'My agent',
    subtitle: 'Private Cloud agent chat',
    bridges: [CLOUD_HOST_SENTINEL],
    status: 'Owned',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: 'Chat privately with My Kordi',
    owner: 'Me',
    bridgeHostId: CLOUD_HOST_SENTINEL,
    bridgePeerNodeId: account.accountId,
    bridgePeerRuntime: CLOUD_AGENT_RUNTIME,
    bridgeHumanId: account.accountId,
    bridgeAgentId: 'cloud-local-agent',
    bridgeContactStatus: 'self',
    bridgeContactRequestDirection: null,
    avatarSeed: account.accountId,
    profileImageUrl: cloudAvatarImageUrl(account.avatarUrl),
  };
}

export function buildCloudDesktopBridgeState({
  account,
  contacts,
  messagesByPeer,
  readInboundMessageIdsByPeer = {},
  readCursorsBySessionId = {},
  activeConversationId,
  localAgentTurnsByRequestId = {},
  localAgentRuntimeRoute = null,
  cloudSessionTitlesById = {},
  hiddenCloudSessionIds = new Set<string>(),
  suppressUnscopedSelfAgentConversation = false,
}: {
  account: CloudAccount;
  contacts: Contact[];
  messagesByPeer: Record<string, CloudMessage[]>;
  readInboundMessageIdsByPeer?: Record<string, Set<string>>;
  readCursorsBySessionId?: Record<string, CloudGroupReadCursor | null | undefined>;
  activeConversationId?: string | null;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
  localAgentRuntimeRoute?: DesktopChatMessageRoute | null;
  cloudSessionTitlesById?: Record<string, string | null | undefined>;
  hiddenCloudSessionIds?: ReadonlySet<string>;
  suppressUnscopedSelfAgentConversation?: boolean;
}): DesktopBridgeState {
  const directContacts = contacts.filter(isDirectCloudContact);
  const host = buildCloudBridgeHost(account, directContacts, localAgentRuntimeRoute);
  const activePeerId = activeConversationId ? cloudPeerAccountIdFromConversationId(activeConversationId) : null;
  const conversationContacts = [cloudSelfContact(account), ...directContacts]
    .filter((contact, index, list) => {
      const peerId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
      return list.findIndex((candidate) => (
        (candidate.bridgePeerNodeId || candidate.id.replace(/^cloud:/, '')) === peerId
      )) === index;
    });
  const conversations = conversationContacts
    .flatMap((contact) => {
      const peerId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
      const messages = messagesByPeer[peerId] ?? [];
      const hasMessages = messages.length > 0;
      const isActivePeer = peerId === activePeerId;
      const isSelfPeer = peerId === account.accountId;
      if (!hasMessages && !isActivePeer) return [];

      const directPersonMessages = isSelfPeer ? [] : cloudDirectPersonMessagesForPeer(account, peerId, messages);
      const hasDirectPersonMessages = directPersonMessages.length > 0;
      const personConversation = !isSelfPeer && (hasDirectPersonMessages || activeConversationId === cloudBridgeConversationId(peerId, CLOUD_PERSON_RUNTIME))
        ? [buildCloudBridgeConversation({
            account,
            contact,
            messages: directPersonMessages,
            runtime: CLOUD_PERSON_RUNTIME,
            readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
            readCursorsBySessionId,
            forceRead: isActivePeer,
            localAgentTurnsByRequestId,
          })]
        : [];
      const activeCloudSessionId = activeConversationId ? cloudSessionIdFromConversationId(activeConversationId) : null;
      const agentConversation = (() => {
        if (isSelfPeer && hasMessages) {
          const bySession = new Map<string | null, CloudMessage[]>();
          const hasSessionScopedMessages = messages.some((cloudMessage) => Boolean(cleanCloudSessionId(cloudMessage.sessionId)));
          for (const cloudMessage of messages) {
            const sessionId = cleanCloudSessionId(cloudMessage.sessionId);
            if (sessionId && hiddenCloudSessionIds.has(sessionId)) continue;
            if ((hasSessionScopedMessages || suppressUnscopedSelfAgentConversation) && !sessionId) continue;
            const bucket = bySession.get(sessionId) ?? [];
            bucket.push(cloudMessage);
            bySession.set(sessionId, bucket);
          }
          return [...bySession.entries()].map(([cloudSessionId, sessionMessages]) => buildCloudBridgeConversation({
            account,
            contact,
            messages: sessionMessages,
            runtime: CLOUD_AGENT_RUNTIME,
            readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
            readCursorsBySessionId,
            forceRead: isActivePeer && (!activeCloudSessionId || activeCloudSessionId === cloudSessionId),
            localAgentTurnsByRequestId,
            cloudSessionId,
            cloudSessionTitle: cloudSessionId ? cloudSessionTitlesById[cloudSessionId] : null,
          }));
        }
        return [];
      })();
      return [...personConversation, ...agentConversation];
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  return {
    configPath: 'cloud',
    legacyConfigPath: 'cloud',
    conversationsPath: 'cloud',
    activeHostId: CLOUD_HOST_SENTINEL,
    hosts: [host],
    conversations,
    localServer: {
      running: true,
      serverUrl: CLOUD_SERVER_LABEL,
      port: null,
      dbPath: null,
      launcher: 'cloud',
      lastError: null,
    },
    localAgentRouting: null,
  };
}

function formatCloudBridgeTime(timestampMs: number): string {
  return formatDesktopClockTime(timestampMs);
}
