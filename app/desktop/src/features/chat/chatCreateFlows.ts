import { isBlankParticipantSpaceSession } from './participantSpaces';
import type {
  Agent,
  CanonicalIdentity,
  Contact,
  Conversation,
  DesktopBridgeSessionParticipant,
  ParticipantSpaceViewModel,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';

export type ChatCreatePersonOption = {
  id: string;
  label: string;
  detail: string;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
  contact: Contact;
};

export type ChatCreateAgentOption = {
  id: string;
  label: string;
  detail: string;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
  agent: Agent;
};

export type ChatAgentSessionKind = 'self-agent' | 'direct-agent';

const BRIDGE_HUMAN_SESSION_PREFIX = 'session:bridge:humans:';

export type ChatGroupMetadata = {
  schemaVersion: 1;
  kind: 'chat-group';
  customName: string | null;
  groupSpaceId: string | null;
  adminIdentityIds: string[];
  initialContactIds: string[];
  initialParticipantNames: string[];
  memberApprovalPolicy: 'under-50-open';
  createdFrom: 'chat-create-flow';
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.map(cleanText).find(Boolean) ?? '';
}

function isContactAgent(contact: Contact) {
  const entityType = contact.entityType.toLowerCase();
  return entityType.includes('agent') || contact.classType === 'my-agents' || contact.classType === 'other-users-agents';
}

function stableIdentitySegment(value: string) {
  return encodeURIComponent(value.trim()).replace(/%/g, '~');
}

function uniqueNonEmpty(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = cleanText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function buildChatCreatePersonOptions(contacts: Contact[]): ChatCreatePersonOption[] {
  return contacts
    .filter((contact) => !isContactAgent(contact))
    .map((contact) => ({
      id: contact.id,
      label: firstNonEmpty(contact.name, contact.owner, contact.id),
      detail: firstNonEmpty(contact.subtitle, contact.detail, contact.entityType),
      avatarSeed: contact.avatarSeed ?? contact.id,
      profileImageUrl: contact.profileImageUrl ?? null,
      contact,
    }));
}

export function buildChatCreateAgentOptions(agents: Agent[]): ChatCreateAgentOption[] {
  return agents.map((agent) => ({
    id: agent.id,
    label: firstNonEmpty(agent.name, agent.id),
    detail: firstNonEmpty(agent.role, agent.messaging, agent.status),
    avatarSeed: agent.avatarSeed ?? agent.id,
    profileImageUrl: agent.profileImageUrl ?? null,
    agent,
  }));
}

export function buildChatAgentSessionKind(agent: Agent): ChatAgentSessionKind {
  return agent.isOwned ? 'self-agent' : 'direct-agent';
}

export function chatSessionIdForAgentStart(agent: Agent, randomId: string) {
  const id = cleanText(randomId) || Date.now().toString(36);
  return `session:${buildChatAgentSessionKind(agent)}:${id}`;
}

export function buildChatAgentSessionMetadata(agent: Agent) {
  return {
    createdFrom: 'chat-create-flow' as const,
    agentId: agent.id,
    participantSpaceKind: 'self' as const,
  };
}

function conversationHasUserContent(conversation: Conversation) {
  if (typeof conversation.canonicalMessageCount === 'number' && conversation.canonicalMessageCount > 0) return true;
  if (conversation.queuedMessages?.length) return true;
  return conversation.messages.some((message) => message.role !== 'system' && message.text.trim().length > 0);
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedMatchKey(value?: string | null) {
  return cleanText(value).toLowerCase();
}

function agentMatchKeys(agent: Agent) {
  const canonicalIdentityId = agentCanonicalIdentityRequest(agent).id;
  const baseKeys = uniqueNonEmpty([
    agent.id,
    cleanText(agent.id).replace(/^agent:/, ''),
    agent.bridgeAgentId ?? '',
    agent.contactId ?? '',
    canonicalIdentityId ?? '',
    cleanText(canonicalIdentityId).replace(/^agent:/, ''),
  ]);
  return new Set(baseKeys.map(normalizedMatchKey).filter(Boolean));
}

function conversationAgentMatchKeys(conversation: Conversation) {
  const metadata = metadataRecord(conversation.metadata);
  return uniqueNonEmpty([
    metadataText(metadata, 'agentId'),
    metadataText(metadata, 'contactId'),
    conversation.bridgeTarget?.agentId ?? '',
    ...(conversation.canonicalParticipants ?? []).filter((participant) => participant.kind === 'agent').flatMap((participant) => [
      participant.id,
      participant.agentId ?? '',
      participant.avatarKey ?? '',
    ]),
  ]).flatMap((key) => [key, key.replace(/^agent:/, '')]);
}

function conversationUpdatedAtMs(conversation: Conversation) {
  const raw = (conversation as Conversation & { _updatedAtMs?: number })._updatedAtMs;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

export function existingBlankSessionIdForAgentStart(agent: Agent, conversations: Conversation[]) {
  const agentKeys = agentMatchKeys(agent);
  const blankConversation = conversations
    .filter((conversation) => {
      if (conversation.type !== 'owned-agent') return false;
      if (conversationHasUserContent(conversation)) return false;
      return conversationAgentMatchKeys(conversation).some((key) => agentKeys.has(normalizedMatchKey(key)));
    })
    .sort((left, right) => conversationUpdatedAtMs(right) - conversationUpdatedAtMs(left))[0];

  return blankConversation?.canonicalSessionId ?? blankConversation?.id ?? null;
}

export function canCreateGroup(selectedContactIds: string[]) {
  return uniqueNonEmpty(selectedContactIds).length >= 2;
}

export function groupDefaultName(names: string[]) {
  const clean = uniqueNonEmpty(names);
  if (clean.length <= 2) return clean.join(', ');
  return `${clean.slice(0, 2).join(', ')} +${clean.length - 2} more`;
}

export type ChatCreateGroupBridgeInviteTarget = {
  hostId: string;
  nodeId: string;
  displayName: string;
  ownerName: string;
  humanId: string | null;
};

export type ChatCreateGroupInviteCreator = Pick<CanonicalIdentity, 'id' | 'displayName' | 'bridgeNodeId' | 'humanId'>;

export const CHAT_GROUP_INVITE_CONTEXT_POLICY = 'session-invite';

export function buildChatCreateGroupInviteText(groupName?: string | null) {
  const name = cleanText(groupName);
  return name ? `You were added to ${name}` : 'You were added to a group chat';
}

export function buildChatCreateGroupBridgeInviteTargets(contacts: Contact[]): ChatCreateGroupBridgeInviteTarget[] {
  const targets = new Map<string, ChatCreateGroupBridgeInviteTarget>();
  for (const contact of contacts) {
    const hostId = cleanText(contact.bridgeHostId);
    const nodeId = cleanText(contact.bridgePeerNodeId);
    if (!hostId || !nodeId) continue;
    const displayName = firstNonEmpty(contact.name, contact.owner, contact.id);
    const ownerName = firstNonEmpty(contact.owner, contact.name, contact.id);
    const humanId = cleanText(contact.bridgeHumanId) || null;
    targets.set(`${hostId}:${nodeId}:${humanId ?? ''}`, { hostId, nodeId, displayName, ownerName, humanId });
  }
  return [...targets.values()];
}

export function buildChatCreateGroupBridgeInviteParticipants(input: {
  creator: ChatCreateGroupInviteCreator | null | undefined;
  contacts: Contact[];
}): DesktopBridgeSessionParticipant[] {
  const participants = new Map<string, DesktopBridgeSessionParticipant>();
  const append = (participant: DesktopBridgeSessionParticipant) => {
    const key = participant.identityId || `${participant.bridgeNodeId ?? ''}:${participant.humanId ?? ''}:${participant.displayName}`;
    if (!participant.displayName.trim() || participants.has(key)) return;
    participants.set(key, participant);
  };

  if (input.creator) {
    append({
      identityId: cleanText(input.creator.id) || null,
      displayName: firstNonEmpty(input.creator.displayName, input.creator.id),
      role: 'self',
      bridgeNodeId: cleanText(input.creator.bridgeNodeId) || null,
      humanId: cleanText(input.creator.humanId) || null,
      agentId: null,
    });
  }

  for (const contact of input.contacts) {
    const identity = contactCanonicalIdentityRequest(contact);
    append({
      identityId: cleanText(identity.id) || null,
      displayName: firstNonEmpty(contact.name, contact.owner, contact.id),
      role: 'person',
      bridgeNodeId: cleanText(contact.bridgePeerNodeId) || null,
      humanId: cleanText(contact.bridgeHumanId) || null,
      agentId: null,
    });
  }

  return [...participants.values()];
}

function participantSpaceHasBridgeHuman(space: ParticipantSpaceViewModel) {
  return space.participants.some((participant) => (
    participant.kind === 'human'
    && participant.role !== 'self'
    && (participant.source === 'bridge' || Boolean(participant.bridgeNodeId?.trim()) || Boolean(participant.humanId?.trim()))
  ));
}

function chatSessionIdPrefixForParticipantSpaceContinuation(space: ParticipantSpaceViewModel) {
  const sourceSessionId = cleanText(space.sessions[0]?.canonicalSessionId) || cleanText(space.sessions[0]?.id);

  if (space.kind === 'direct-human') {
    if (sourceSessionId.startsWith(BRIDGE_HUMAN_SESSION_PREFIX) || participantSpaceHasBridgeHuman(space)) {
      return BRIDGE_HUMAN_SESSION_PREFIX;
    }
    return 'session:direct-person:';
  }
  if (space.kind === 'group') return 'session:group:';
  if (space.kind === 'direct-agent') return 'session:direct-agent:';
  return 'session:self-agent:';
}

export function chatSessionIdForParticipantSpaceContinuation(space: ParticipantSpaceViewModel, randomId: string) {
  const id = cleanText(randomId) || Date.now().toString(36);
  return `${chatSessionIdPrefixForParticipantSpaceContinuation(space)}${id}`;
}

export function existingBlankSessionIdForParticipantSpace(space: ParticipantSpaceViewModel) {
  const blankSession = [...space.sessions]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .find(isBlankParticipantSpaceSession);
  return blankSession?.canonicalSessionId ?? blankSession?.id ?? null;
}

export function participantSpaceCanonicalSessionIds(space: ParticipantSpaceViewModel) {
  return uniqueNonEmpty(space.sessions.map((session) => session.canonicalSessionId ?? session.id));
}

export function buildChatCreateGroupMetadata(input: {
  creatorIdentityId: string;
  selectedContactIds: string[];
  selectedNames: string[];
  customName?: string | null;
  groupSpaceId?: string | null;
}): ChatGroupMetadata {
  const customName = cleanText(input.customName);
  const groupSpaceId = cleanText(input.groupSpaceId);
  return {
    schemaVersion: 1,
    kind: 'chat-group',
    customName: customName || null,
    groupSpaceId: groupSpaceId || null,
    adminIdentityIds: uniqueNonEmpty([input.creatorIdentityId]),
    initialContactIds: uniqueNonEmpty(input.selectedContactIds),
    initialParticipantNames: uniqueNonEmpty(input.selectedNames),
    memberApprovalPolicy: 'under-50-open',
    createdFrom: 'chat-create-flow',
  };
}

export function readChatGroupMetadata(metadata: unknown): Partial<ChatGroupMetadata> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata as Partial<ChatGroupMetadata>;
}

export function adminIdentityIdsFromMetadata(metadata: unknown) {
  const candidate = readChatGroupMetadata(metadata).adminIdentityIds;
  return Array.isArray(candidate) ? uniqueNonEmpty(candidate) : [];
}

export function contactCanonicalIdentityRequest(contact: Contact): UpsertCanonicalIdentityRequest {
  const humanId = cleanText(contact.bridgeHumanId);
  const bridgeNodeId = cleanText(contact.bridgePeerNodeId);
  const explicitId = contact.id.startsWith('human:')
    ? contact.id
    : humanId
      ? `human:${humanId}`
      : bridgeNodeId
        ? `human:bridge-node:${bridgeNodeId}`
        : `human:contact:${stableIdentitySegment(contact.id)}`;
  return {
    id: explicitId,
    kind: 'human',
    displayName: firstNonEmpty(contact.name, contact.owner, contact.id),
    source: contact.bridgeHostId || contact.bridgePeerNodeId ? 'bridge' : 'local',
    sourceHostId: contact.bridgeHostId ?? null,
    bridgeNodeId: bridgeNodeId || null,
    humanId: humanId || null,
    agentId: null,
    avatarKey: contact.avatarSeed ?? (humanId || contact.id),
    profileImageUrl: contact.profileImageUrl ?? null,
    metadata: {
      contactId: contact.id,
      classType: contact.classType,
      entityType: contact.entityType,
    },
  };
}

export function agentCanonicalIdentityRequest(agent: Agent): UpsertCanonicalIdentityRequest {
  const agentId = cleanText(agent.bridgeAgentId) || cleanText(agent.id).replace(/^agent:/, '');
  const explicitId = agent.id.startsWith('agent:') ? agent.id : agentId ? `agent:${stableIdentitySegment(agentId)}` : null;
  return {
    id: explicitId,
    kind: 'agent',
    displayName: firstNonEmpty(agent.name, agent.id),
    ownerIdentityId: null,
    source: agent.bridgeHostId || agent.bridgePeerNodeId ? 'bridge' : 'local',
    sourceHostId: agent.bridgeHostId ?? null,
    bridgeNodeId: agent.bridgePeerNodeId ?? null,
    humanId: null,
    agentId: agentId || null,
    avatarKey: agent.avatarSeed ?? (agentId || agent.id),
    profileImageUrl: agent.profileImageUrl ?? null,
    metadata: {
      agentId: agent.id,
      contactId: agent.contactId,
      isOwned: Boolean(agent.isOwned),
    },
  };
}
