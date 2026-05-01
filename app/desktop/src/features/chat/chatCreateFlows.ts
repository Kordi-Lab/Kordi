import type {
  Agent,
  Contact,
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

export type ChatGroupMetadata = {
  schemaVersion: 1;
  kind: 'chat-group';
  customName: string | null;
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

export function canCreateGroup(selectedContactIds: string[]) {
  return uniqueNonEmpty(selectedContactIds).length >= 2;
}

export function groupDefaultName(names: string[]) {
  const clean = uniqueNonEmpty(names);
  if (clean.length <= 2) return clean.join(', ');
  return `${clean.slice(0, 2).join(', ')} +${clean.length - 2} more`;
}

export function buildChatCreateGroupMetadata(input: {
  creatorIdentityId: string;
  selectedContactIds: string[];
  selectedNames: string[];
  customName?: string | null;
}): ChatGroupMetadata {
  const customName = cleanText(input.customName);
  return {
    schemaVersion: 1,
    kind: 'chat-group',
    customName: customName || null,
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
  const explicitId = contact.id.startsWith('human:') ? contact.id : humanId ? `human:${humanId}` : null;
  return {
    id: explicitId,
    kind: 'human',
    displayName: firstNonEmpty(contact.name, contact.owner, contact.id),
    source: contact.bridgeHostId || contact.bridgePeerNodeId ? 'bridge' : 'local',
    sourceHostId: contact.bridgeHostId ?? null,
    bridgeNodeId: contact.bridgePeerNodeId ?? null,
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
  const explicitId = agent.id.startsWith('agent:') ? agent.id : agentId ? `agent:${agentId}` : null;
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
