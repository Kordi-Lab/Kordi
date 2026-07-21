import { isBlankParticipantSpaceSession, isPersistedBlankGroupContinuation } from './participantSpaces';
import type {
  Agent,
  CanonicalIdentity,
  Contact,
  Conversation,
  ConversationParticipant,
  DesktopBridgeSessionParticipant,
  ParticipantSpaceViewModel,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import type { CloudAgentDefinition } from '@/features/cloud/cloudAgents';

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

export type BridgeAgentStartInput = {
  hostId: string;
  nodeId: string;
  displayName?: string | null;
  ownerName?: string | null;
  runtime?: string | null;
  agentId?: string | null;
  contactId?: string | null;
  profileImageUrl?: string | null;
};

const BRIDGE_HUMAN_SESSION_PREFIX = 'session:bridge:humans:';

export type ChatGroupMetadata = {
  schemaVersion: 1;
  kind: 'chat-group';
  customName: string | null;
  groupId: string | null;
  groupSpaceId: string | null;
  groupCreatorIdentityId: string;
  adminIdentityIds: string[];
  groupAdminUpdatedAtMs: number;
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
    .filter((contact) => !isContactAgent(contact) && isApprovedBridgeContact(contact))
    .map((contact) => ({
      id: contact.id,
      label: firstNonEmpty(contact.name, contact.owner, contact.id),
      detail: firstNonEmpty(contact.subtitle, contact.detail, contact.entityType),
      avatarSeed: contact.avatarSeed ?? contact.id,
      profileImageUrl: contact.profileImageUrl ?? null,
      contact,
    }));
}

export function isApprovedBridgeContact(contact: Contact) {
  const peerNodeId = cleanText(contact.bridgePeerNodeId);
  if (!peerNodeId) return true;
  const status = cleanText(contact.bridgeContactStatus).toLowerCase();
  return status === 'contact' || status === 'approved' || status === 'accepted';
}

export function buildChatCreateGroupPersonOptions(contacts: Contact[]): ChatCreatePersonOption[] {
  return buildChatCreatePersonOptions(contacts).filter((option) => isApprovedBridgeContact(option.contact));
}

export function buildChatCreatePeopleContactLookup(contacts: Contact[]): Map<string, Contact> {
  const lookup = new Map<string, Contact>();
  for (const option of buildChatCreatePersonOptions(contacts)) {
    lookup.set(option.id, option.contact);
    const cloudAccountId = option.contact.bridgeHostId === 'cloud'
      ? cleanText(option.contact.bridgePeerNodeId) || cleanText(option.contact.bridgeHumanId)
      : '';
    if (cloudAccountId) lookup.set(`cloud:${cloudAccountId}`, option.contact);
  }
  return lookup;
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

export function bridgeAgentForChatStart(input: BridgeAgentStartInput): Agent {
  const hostId = cleanText(input.hostId);
  const nodeId = cleanText(input.nodeId);
  const agentId = cleanText(input.agentId);
  const ownerName = cleanText(input.ownerName);
  const displayName = firstNonEmpty(input.displayName, ownerName ? `${ownerName}'s Kordi` : null, agentId, nodeId);
  const canonicalId = agentId
    ? `agent:${stableIdentitySegment(agentId)}`
    : `agent:bridge-node:${stableIdentitySegment(nodeId || displayName)}`;

  return {
    id: canonicalId,
    name: displayName,
    role: 'External Bridge agent',
    messaging: 'Start a Bridge agent chat',
    status: 'Available',
    tasks: 0,
    defaultProvider: '',
    defaultModel: '',
    bridgesConfig: 'Bridge',
    contactId: cleanText(input.contactId) || canonicalId,
    systemPrompt: '',
    xMd: '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    bridgeHostId: hostId || undefined,
    bridgePeerNodeId: nodeId || undefined,
    bridgePeerRuntime: cleanText(input.runtime) || 'kordi-desktop',
    bridgeAgentId: agentId || undefined,
    bridgeOwnerName: ownerName || undefined,
    isOwned: false,
    avatarSeed: agentId || nodeId || canonicalId,
    profileImageUrl: input.profileImageUrl ?? null,
  };
}

export function buildChatAgentSessionKind(agent: Agent): ChatAgentSessionKind {
  return agent.isOwned ? 'self-agent' : 'direct-agent';
}

export function chatSessionIdForPersonStart(randomId: string) {
  const id = cleanText(randomId) || Date.now().toString(36);
  return `session:direct-person:${id}`;
}

export function chatSessionIdForAgentStart(agent: Agent, randomId: string) {
  const id = cleanText(randomId) || Date.now().toString(36);
  return `session:${buildChatAgentSessionKind(agent)}:${id}`;
}

export function buildChatAgentSessionMetadata(agent: Agent) {
  const bridgeHostId = cleanText(agent.bridgeHostId);
  const peerNodeId = cleanText(agent.bridgePeerNodeId);
  const peerRuntime = cleanText(agent.bridgePeerRuntime);
  const peerDisplayName = cleanText(agent.name);
  const peerOwnerName = cleanText(agent.bridgeOwnerName);
  const peerAgentId = cleanText(agent.bridgeAgentId);
  const cloudAgentId = cleanText(agent.cloudAgentId);

  return {
    createdFrom: 'chat-create-flow' as const,
    agentId: agent.id,
    participantSpaceKind: 'self' as const,
    ...(bridgeHostId ? { bridgeHostId } : {}),
    ...(peerNodeId ? { peerNodeId } : {}),
    ...(peerRuntime ? { peerRuntime } : {}),
    ...(peerDisplayName && bridgeHostId ? { peerDisplayName } : {}),
    ...(peerOwnerName ? { peerOwnerName } : {}),
    ...(peerAgentId ? { peerAgentId, targetAgentId: peerAgentId } : {}),
    ...(cloudAgentId ? {
      cloudAgentId,
      cloudAgentName: agent.name,
      cloudAgentRole: agent.role,
      cloudAgentSystemPrompt: agent.systemPrompt,
      cloudAgentSourceSummary: agent.cloudAgentSourceSummary ?? null,
      cloudAgentBoundaries: agent.cloudAgentBoundaries ?? [],
      cloudAgentSkills: agent.cloudAgentSkills ?? [],
    } : {}),
  };
}

export function cloudAgentContextMessagesFromDefinition(definition: Pick<CloudAgentDefinition, 'agentId' | 'name' | 'role' | 'systemPrompt' | 'sourceSummary' | 'boundaries' | 'skills'> | null | undefined) {
  const cloudAgentId = cleanText(definition?.agentId);
  const name = cleanText(definition?.name);
  const role = cleanText(definition?.role);
  const systemPrompt = cleanText(definition?.systemPrompt);
  if (!cloudAgentId || !name || !systemPrompt) return [];

  const sourceSummary = cleanText(definition?.sourceSummary);
  const boundaries = definition?.boundaries ?? [];
  const skills = definition?.skills ?? [];
  const text = [
    `You are ${name}${role ? `, ${role}` : ''}.`,
    'For this conversation, answer as this private Cloud Agent rather than the default Kordi agent.',
    'Cloud Agent system prompt:',
    systemPrompt,
    sourceSummary ? `Source summary: ${sourceSummary}` : '',
    boundaries.length ? `Boundaries:\n${boundaries.map((boundary) => `- ${boundary}`).join('\n')}` : '',
    skills.length ? `Suggested skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  return [{
    id: `cloud-agent-definition:${cloudAgentId}`,
    authorName: `${name} definition`,
    authorKind: 'agent' as const,
    text,
    createdAtMs: null,
  }];
}

export function cloudAgentContextMessagesFromConversation(conversation: unknown) {
  const conversationRecord = metadataRecord(conversation);
  const metadata = metadataRecord(conversationRecord.metadata);
  return cloudAgentContextMessagesFromDefinition({
    agentId: metadataText(metadata, 'cloudAgentId'),
    name: metadataText(metadata, 'cloudAgentName'),
    role: metadataText(metadata, 'cloudAgentRole'),
    systemPrompt: metadataText(metadata, 'cloudAgentSystemPrompt'),
    sourceSummary: metadataText(metadata, 'cloudAgentSourceSummary'),
    boundaries: metadataStringArray(metadata, 'cloudAgentBoundaries'),
    skills: metadataSkills(metadata),
  });
}

export type ParticipantSpaceContinuationMetadataInput = {
  sourceMetadata?: Record<string, unknown> | null;
  continuedFromSessionId: string | null;
  continuedFromSpaceId: string;
  participantSpaceKind: ParticipantSpaceViewModel['kind'];
};

const BRIDGE_CONTINUATION_METADATA_KEYS = [
  'source',
  'bridgeConversationId',
  'bridgeHostId',
  'peerNodeId',
  'peerRuntime',
  'peerDisplayName',
  'peerOwnerName',
  'peerHumanId',
  'peerAgentId',
  'targetAgentId',
] as const;

export function buildParticipantSpaceContinuationMetadata(input: ParticipantSpaceContinuationMetadataInput) {
  const sourceMetadata = metadataRecord(input.sourceMetadata);
  const inheritedBridgeMetadata = BRIDGE_CONTINUATION_METADATA_KEYS.reduce<Record<string, string>>((metadata, key) => {
    const value = sourceMetadata[key];
    if (typeof value !== 'string') return metadata;
    const trimmed = value.trim();
    if (trimmed) {
      metadata[key] = trimmed;
    }
    return metadata;
  }, {});

  return {
    createdFrom: 'chat-create-flow' as const,
    ...inheritedBridgeMetadata,
    continuedFromSessionId: input.continuedFromSessionId,
    continuedFromSpaceId: input.continuedFromSpaceId,
    participantSpaceKind: input.participantSpaceKind,
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

function metadataStringArray(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function metadataSkills(metadata: Record<string, unknown>) {
  const value = metadata.cloudAgentSkills;
  if (!Array.isArray(value)) return [] as Array<{ name: string; description: string }>;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    return name && description ? [{ name, description }] : [];
  });
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

function personMatchKeys(contact: Contact) {
  const identityRequest = contactCanonicalIdentityRequest(contact);
  const canonicalIdentityId = identityRequest.id;
  const baseKeys = uniqueNonEmpty([
    contact.id,
    cleanText(contact.id).replace(/^human:/, ''),
    contact.bridgeHumanId ?? '',
    contact.bridgePeerNodeId ?? '',
    canonicalIdentityId ?? '',
    cleanText(canonicalIdentityId).replace(/^human:/, ''),
  ]);
  return new Set(baseKeys.map(normalizedMatchKey).filter(Boolean));
}

function conversationPersonMatchKeys(conversation: Conversation) {
  const metadata = metadataRecord(conversation.metadata);
  return uniqueNonEmpty([
    metadataText(metadata, 'contactId'),
    metadataText(metadata, 'peerHumanId'),
    metadataText(metadata, 'peerNodeId'),
    conversation.bridgeTarget?.humanId ?? '',
    conversation.bridgeTarget?.nodeId ?? '',
    ...(conversation.canonicalParticipants ?? []).filter((participant) => participant.kind === 'human' && participant.role !== 'self').flatMap((participant) => [
      participant.id,
      participant.humanId ?? '',
      participant.bridgeNodeId ?? '',
      participant.avatarKey ?? '',
    ]),
  ]).flatMap((key) => [key, key.replace(/^human:/, '')]);
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

export function existingSessionIdForPersonStart(contact: Contact, conversations: Conversation[]) {
  const personKeys = personMatchKeys(contact);
  const existingConversation = conversations
    .filter((conversation) => {
      if (conversation.type !== 'person') return false;
      return conversationPersonMatchKeys(conversation).some((key) => personKeys.has(normalizedMatchKey(key)));
    })
    .sort((left, right) => conversationUpdatedAtMs(right) - conversationUpdatedAtMs(left))[0];

  return existingConversation?.canonicalSessionId ?? existingConversation?.id ?? null;
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
export const CHAT_GROUP_UPDATE_CONTEXT_POLICY = 'session-update';
export const CHAT_GROUP_SESSION_TITLE_UPDATE_CONTEXT_POLICY = 'session-title-update';

export type ChatGroupBridgeUpdateTarget = ChatCreateGroupBridgeInviteTarget;

export function buildChatCreateGroupInviteText(groupName?: string | null) {
  const name = cleanText(groupName);
  return name ? `You were added to ${name}` : 'You were added to a group chat';
}

export function buildChatCreateGroupBridgeInviteTargets(contacts: Contact[]): ChatCreateGroupBridgeInviteTarget[] {
  const targets = new Map<string, ChatCreateGroupBridgeInviteTarget>();
  for (const contact of contacts) {
    if (!isApprovedBridgeContact(contact)) continue;
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
      role: 'admin',
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

export function buildChatGroupBridgeUpdateTargets(input: {
  actorIdentityId: string;
  participants: ConversationParticipant[];
}): ChatGroupBridgeUpdateTarget[] {
  const actorIdentityId = cleanText(input.actorIdentityId);
  const targets = new Map<string, ChatGroupBridgeUpdateTarget>();
  for (const participant of input.participants) {
    if (participant.kind !== 'human' || participant.id === actorIdentityId) continue;
    const hostId = cleanText(participant.bridgeHostId);
    const nodeId = cleanText(participant.bridgeNodeId);
    if (!hostId || !nodeId) continue;
    const displayName = firstNonEmpty(participant.name, participant.id);
    const humanId = cleanText(participant.humanId) || null;
    targets.set(`${hostId}:${nodeId}:${humanId ?? ''}`, {
      hostId,
      nodeId,
      displayName,
      ownerName: displayName,
      humanId,
    });
  }
  return [...targets.values()];
}

export function buildChatGroupBridgeUpdateParticipants(input: {
  participants: ConversationParticipant[];
  adminIdentityIds: string[];
}): DesktopBridgeSessionParticipant[] {
  const adminIds = new Set(uniqueNonEmpty(input.adminIdentityIds));
  const participants = new Map<string, DesktopBridgeSessionParticipant>();
  for (const participant of input.participants) {
    if (participant.kind !== 'human') continue;
    const displayName = firstNonEmpty(participant.name, participant.id);
    const humanId = cleanText(participant.humanId) || null;
    const bridgeNodeId = cleanText(participant.bridgeNodeId) || null;
    const key = participant.id || `${bridgeNodeId ?? ''}:${humanId ?? ''}:${displayName}`;
    if (!displayName || participants.has(key)) continue;
    participants.set(key, {
      identityId: cleanText(participant.id) || null,
      displayName,
      role: adminIds.has(participant.id) ? 'admin' : 'person',
      bridgeNodeId,
      humanId,
      agentId: null,
      avatarKey: cleanText(participant.avatarKey) || null,
      profileImageUrl: cleanText(participant.profileImageUrl) || null,
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
  return uniqueNonEmpty(space.sessions
    .filter((session) => !session.conversation.transientDraft)
    .filter((session) => space.kind !== 'group' || !isPersistedBlankGroupContinuation(session))
    .map((session) => session.canonicalSessionId ?? session.id));
}

export function participantSpaceCanonicalMembershipSessionIds(space: ParticipantSpaceViewModel) {
  return uniqueNonEmpty([
    ...(space.membershipSessionIds ?? []),
    ...participantSpaceCanonicalSessionIds(space),
  ]);
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
    groupId: groupSpaceId || null,
    groupSpaceId: groupSpaceId || null,
    groupCreatorIdentityId: cleanText(input.creatorIdentityId),
    adminIdentityIds: uniqueNonEmpty([input.creatorIdentityId]),
    groupAdminUpdatedAtMs: Date.now(),
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
