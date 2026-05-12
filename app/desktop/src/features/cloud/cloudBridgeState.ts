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

import type { CloudAccount, CloudMessage } from './authClient';
import { cloudAvatarImageUrl } from './avatar';
import {
  cloudGroupIdentityRequest,
  cloudGroupParticipantFromContact,
  cloudGroupSelfParticipant,
  isCloudGroupControlMessage,
} from './cloudGroupMessages';
import {
  cloudMessageMentionsFirstPersonAgent,
  cloudMessageMentionsLocalAgent,
  cloudMessageMentionsNamedAgent,
  isCloudAgentControlMessage,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import { CLOUD_HOST_SENTINEL } from './useCloudContacts';

const CLOUD_SERVER_LABEL = 'kordi.cloud';
const CLOUD_PERSON_RUNTIME = 'person';
const CLOUD_AGENT_RUNTIME = 'kordi-desktop';

export function isCloudBridgeHostId(hostId: string | null | undefined): boolean {
  return hostId === CLOUD_HOST_SENTINEL;
}

export function cloudBridgeConversationId(peerAccountId: string, runtime: string = CLOUD_PERSON_RUNTIME): string {
  const suffix = runtime.trim().toLowerCase() === CLOUD_PERSON_RUNTIME ? ':person' : '';
  return `bridge:${CLOUD_HOST_SENTINEL}:${peerAccountId}${suffix}`;
}

export function cloudPeerAccountIdFromConversationId(conversationId: string): string | null {
  const prefix = `bridge:${CLOUD_HOST_SENTINEL}:`;
  if (!conversationId.startsWith(prefix)) return null;
  const rest = conversationId.slice(prefix.length);
  if (!rest) return null;
  return rest.endsWith(':person') ? rest.slice(0, -':person'.length) : rest;
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

function cloudMessageMentionsContactAgent(message: CloudMessage, contact: Contact | undefined): boolean {
  if (!contact) return false;
  return cloudMessageMentionsNamedAgent(message.body, cloudAgentDisplayName(contact))
    || cloudMessageMentionsNamedAgent(message.body, cloudPeerDisplayName(contact));
}

export function cloudMessageToBridgeMessage(
  account: CloudAccount,
  message: CloudMessage,
  contact?: Contact,
  options: { cancelledRequestIds?: Set<string>; localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot> } = {},
): DesktopBridgeConversationMessage {
  const timestampMs = Date.parse(message.createdAt) || Date.now();
  const agentResponse = parseCloudAgentResponse(message.body);
  const isOwn = message.fromAccountId === account.accountId;
  const agentRequestId = !agentResponse && (
    cloudMessageMentionsLocalAgent(message.body, account, { allowFirstPerson: isOwn })
    || cloudMessageMentionsContactAgent(message, contact)
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
    sender: agentResponse ? null : isOwn ? 'Me' : null,
    text: agentResponse?.text ?? message.body,
    timeLabel: formatCloudBridgeTime(timestampMs),
    timestampMs,
    requestId: agentResponse?.requestId ?? agentRequestId,
    deliveryState: options.cancelledRequestIds?.has(message.messageId)
      ? 'cancelled'
      : message.direction === 'outgoing'
        ? (message.readAt ? 'read' : 'delivered')
        : null,
    detail: undefined,
    attachments: [],
    localTurn: agentResponse?.requestId ? options.localAgentTurnsByRequestId?.[agentResponse.requestId] ?? null : null,
  };
}

export function buildCloudBridgeHost(account: CloudAccount, contacts: Contact[]): DesktopBridgeHost {
  const displayName = account.displayName?.trim() || account.primaryEmail?.trim() || 'Cloud user';
  const peers = contacts.flatMap((contact) => [
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
      defaultModel: null,
      defaultAuthProvider: null,
      defaultAuthChoice: null,
      fallbackModel: null,
      fallbackAuthProvider: null,
      fallbackAuthChoice: null,
      thinking: null,
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
  forceRead = false,
  localAgentTurnsByRequestId = {},
}: {
  account: CloudAccount;
  contact: Contact;
  messages: CloudMessage[];
  runtime?: string;
  readInboundMessageIds?: Set<string>;
  forceRead?: boolean;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
}): DesktopBridgeConversation {
  const peerAccountId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
  const isPerson = runtime.trim().toLowerCase() === CLOUD_PERSON_RUNTIME;
  const title = isPerson ? cloudPeerDisplayName(contact) : cloudAgentDisplayName(contact);
  const cancelledRequestIds = new Set(messages
    .map((message) => parseCloudAgentCancel(message.body)?.requestId)
    .filter((value): value is string => Boolean(value)));
  const requestTargetAccountIds = new Map<string, string>();
  for (const message of messages) {
    if (parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
    if (cloudMessageMentionsFirstPersonAgent(message.body)) {
      requestTargetAccountIds.set(message.messageId, message.fromAccountId);
    } else if (cloudMessageMentionsContactAgent(message, contact)) {
      requestTargetAccountIds.set(message.messageId, peerAccountId);
    } else if (cloudMessageMentionsLocalAgent(message.body, account, { allowFirstPerson: false })) {
      requestTargetAccountIds.set(message.messageId, account.accountId);
    }
  }
  const visibleCloudMessages = messages.filter((message) => {
    if (isCloudAgentControlMessage(message.body) || isCloudGroupControlMessage(message.body)) return false;
    const response = parseCloudAgentResponse(message.body);
    if (!response) return true;
    const expectedResponderAccountId = requestTargetAccountIds.get(response.requestId);
    return !expectedResponderAccountId || message.fromAccountId === expectedResponderAccountId;
  });
  const bridgeMessages = visibleCloudMessages.map((message) => cloudMessageToBridgeMessage(account, message, contact, { cancelledRequestIds, localAgentTurnsByRequestId }));
  const agentRequests = messages.filter((message) => {
    if (parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) return false;
    return Boolean(requestTargetAccountIds.get(message.messageId));
  });
  const answeredRequestIds = new Set(messages
    .map((message) => parseCloudAgentResponse(message.body)?.requestId)
    .filter((value): value is string => Boolean(value)));
  for (const requestId of cancelledRequestIds) answeredRequestIds.add(requestId);
  const pendingAgentRequest = [...agentRequests]
    .reverse()
    .find((message) => !answeredRequestIds.has(message.messageId));
  const last = bridgeMessages[bridgeMessages.length - 1] ?? null;
  const updatedAtMs = last?.timestampMs ?? Date.now();
  const conversationId = cloudBridgeConversationId(peerAccountId, runtime);
  const pendingAgentTargetsLocalAgent = pendingAgentRequest
    ? requestTargetAccountIds.get(pendingAgentRequest.messageId) === account.accountId
    : false;
  const pendingAgentOwnerName = pendingAgentTargetsLocalAgent
    ? (account.displayName || account.primaryEmail || 'Me')
    : cloudPeerDisplayName(contact);
  const pendingAgentDisplayName = pendingAgentTargetsLocalAgent
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
    requestText: promptTextForCloudAgentMention(pendingAgentRequest.body),
    triggerText: pendingAgentRequest.body,
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
    canonicalSessionId: `session:bridge:${conversationId}`,
    hostId: CLOUD_HOST_SENTINEL,
    peerNodeId: peerAccountId,
    peerDisplayName: title,
    peerOwnerName: cloudPeerDisplayName(contact),
    peerRuntime: runtime,
    projectId: null,
    projectName: null,
    title,
    subtitle: last?.text || (isPerson ? 'Direct human chat' : 'Remote agent thread'),
    unreadCount: forceRead
      ? 0
      : visibleCloudMessages.filter((message) => (
          message.toAccountId === account.accountId
          && !message.readAt
          && !readInboundMessageIds?.has(message.messageId)
        )).length,
    updatedAtMs,
    updatedAtLabel: formatCloudBridgeTime(updatedAtMs),
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
      remoteHumanName: cloudPeerDisplayName(contact),
      remoteHumanNodeId: peerAccountId,
      remoteAgentId: `cloud-agent:${peerAccountId}`,
      remoteAgentName: cloudAgentDisplayName(contact),
      remoteAgentNodeId: peerAccountId,
      remoteAgentRuntime: CLOUD_AGENT_RUNTIME,
    },
    messages: bridgeMessages,
  };
}

export function buildCloudDesktopBridgeState({
  account,
  contacts,
  messagesByPeer,
  readInboundMessageIdsByPeer = {},
  activeConversationId,
  localAgentTurnsByRequestId = {},
}: {
  account: CloudAccount;
  contacts: Contact[];
  messagesByPeer: Record<string, CloudMessage[]>;
  readInboundMessageIdsByPeer?: Record<string, Set<string>>;
  activeConversationId?: string | null;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
}): DesktopBridgeState {
  const host = buildCloudBridgeHost(account, contacts);
  const activePeerId = activeConversationId ? cloudPeerAccountIdFromConversationId(activeConversationId) : null;
  const conversations = contacts
    .flatMap((contact) => {
      const peerId = contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, '');
      const messages = messagesByPeer[peerId] ?? [];
      const hasMessages = messages.length > 0;
      const isActivePeer = peerId === activePeerId;
      if (!hasMessages && !isActivePeer) return [];

      const personConversation = hasMessages || activeConversationId === cloudBridgeConversationId(peerId, CLOUD_PERSON_RUNTIME)
        ? [buildCloudBridgeConversation({
            account,
            contact,
            messages,
            runtime: CLOUD_PERSON_RUNTIME,
            readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
            forceRead: isActivePeer,
            localAgentTurnsByRequestId,
          })]
        : [];
      const agentConversation = activeConversationId === cloudBridgeConversationId(peerId, CLOUD_AGENT_RUNTIME)
        ? [buildCloudBridgeConversation({
            account,
            contact,
            messages,
            runtime: CLOUD_AGENT_RUNTIME,
            readInboundMessageIds: readInboundMessageIdsByPeer[peerId],
            forceRead: isActivePeer,
            localAgentTurnsByRequestId,
          })]
        : [];
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

export function mergeCloudBridgeState(
  base: DesktopBridgeState | null,
  cloud: DesktopBridgeState | null,
): DesktopBridgeState | null {
  if (!cloud) return base;
  if (!base) return cloud;
  const cloudHostIds = new Set(cloud.hosts.map((host) => host.id));
  return {
    ...base,
    activeHostId: base.activeHostId ?? cloud.activeHostId,
    hosts: [
      ...base.hosts.filter((host) => !cloudHostIds.has(host.id)),
      ...cloud.hosts,
    ],
    conversations: [
      ...base.conversations.filter((conversation) => !cloudHostIds.has(conversation.hostId)),
      ...cloud.conversations,
    ].sort((left, right) => right.updatedAtMs - left.updatedAtMs),
    localServer: base.localServer.running ? base.localServer : cloud.localServer,
  };
}

function formatCloudBridgeTime(timestampMs: number): string {
  return new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestampMs));
}
