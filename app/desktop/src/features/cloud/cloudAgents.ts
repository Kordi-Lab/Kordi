import type { Agent } from '@/kordi-app/types';
import type { CloudSyncEvent } from './authClient';
import type {
  CloudAgentAccessScope,
  CloudAgentMentionPermissions,
  CloudAgentProactiveConfig,
  CloudAgentResource,
  CloudAgentSkill,
  CloudAgentStatus,
} from './cloudAgentsClient';

export type CloudAgentDefinition = {
  agentId: string;
  ownerAccountId: string;
  accessScope: CloudAgentAccessScope;
  status: CloudAgentStatus;
  name: string;
  role: string;
  description: string | null;
  systemPrompt: string;
  sourceSummary: string | null;
  boundaries: string[];
  resources: CloudAgentResource[];
  skills: CloudAgentSkill[];
  modelRouting: Record<string, unknown>;
  proactive: CloudAgentProactiveConfig;
  mentionPermissions: CloudAgentMentionPermissions;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanNullableText(value: unknown): string | null {
  const text = cleanText(value);
  return text || null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanText).filter(Boolean))];
}

function normalizeResources(value: unknown): CloudAgentResource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = objectRecord(entry);
    const kind = cleanText(record?.kind);
    const rawValue = cleanText(record?.value);
    if (!kind || !rawValue) return [];
    return [{
      kind,
      value: rawValue,
      title: cleanNullableText(record?.title),
      summary: cleanNullableText(record?.summary),
    }];
  });
}

function normalizeSkills(value: unknown): CloudAgentSkill[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const record = objectRecord(entry);
    const name = cleanText(record?.name);
    const description = cleanText(record?.description);
    if (!name || !description || seen.has(name)) return [];
    seen.add(name);
    return [{ name, description, content: cleanNullableText(record?.content) }];
  });
}

function normalizeModelRouting(value: unknown): Record<string, unknown> {
  return objectRecord(value) ?? {};
}

function normalizeProactive(value: unknown): CloudAgentProactiveConfig {
  const record = objectRecord(value);
  return {
    enabled: record?.enabled === true,
    skillPack: 'proact-v1',
  };
}

function normalizeMentionPermissions(value: unknown): CloudAgentMentionPermissions {
  const record = objectRecord(value);
  if (!record) {
    // Older servers predate outbound mention controls and allowed both kinds.
    return { people: true, agents: true };
  }
  return {
    people: record.people === true,
    agents: record.agents === true,
  };
}

export function normalizeCloudAgentDefinition(value: unknown): CloudAgentDefinition | null {
  const record = objectRecord(value);
  if (!record) return null;
  const agentId = cleanText(record.agentId);
  const ownerAccountId = cleanText(record.ownerAccountId);
  const accessScope = cleanText(record.accessScope);
  const status = cleanText(record.status);
  const name = cleanText(record.name);
  const role = cleanText(record.role);
  const systemPrompt = cleanText(record.systemPrompt);
  const createdAt = cleanText(record.createdAt);
  const updatedAt = cleanText(record.updatedAt);
  if (!agentId || !ownerAccountId || !['private', 'participant_conversations'].includes(accessScope) || !['active', 'archived'].includes(status) || !name || !role || !systemPrompt || !createdAt || !updatedAt) {
    return null;
  }
  return {
    agentId,
    ownerAccountId,
    accessScope: accessScope as CloudAgentAccessScope,
    status: status as CloudAgentStatus,
    name,
    role,
    description: cleanNullableText(record.description),
    systemPrompt,
    sourceSummary: cleanNullableText(record.sourceSummary),
    boundaries: normalizeStringArray(record.boundaries),
    resources: normalizeResources(record.resources),
    skills: normalizeSkills(record.skills),
    modelRouting: normalizeModelRouting(record.modelRouting),
    proactive: normalizeProactive(record.proactive),
    mentionPermissions: normalizeMentionPermissions(record.mentionPermissions),
    createdAt,
    updatedAt,
    archivedAt: cleanNullableText(record.archivedAt),
  };
}

function cloudAgentId(definition: CloudAgentDefinition): string {
  return `cloud-agent:${definition.agentId}`;
}

export function cloudAgentDefinitionToAgent(definition: CloudAgentDefinition): Agent {
  const defaultModel = typeof definition.modelRouting.defaultModel === 'string' ? definition.modelRouting.defaultModel : '';
  const defaultAuthProvider = typeof definition.modelRouting.defaultAuthProvider === 'string' ? definition.modelRouting.defaultAuthProvider : null;
  const defaultAuthChoice = typeof definition.modelRouting.defaultAuthChoice === 'string' ? definition.modelRouting.defaultAuthChoice : null;
  const defaultThinking = typeof definition.modelRouting.thinking === 'string' ? definition.modelRouting.thinking : null;
  const loadedTools = normalizeStringArray(definition.modelRouting.tools);
  const loadedPlugins = normalizeStringArray(definition.modelRouting.plugins);
  return {
    name: definition.name,
    id: cloudAgentId(definition),
    role: definition.role,
    messaging: 'Cloud synced',
    status: definition.accessScope === 'private' ? 'Private' : 'Shared',
    tasks: 0,
    defaultProvider: 'Cloud',
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice,
    defaultThinking,
    collaborationConfig: 'Cloud Agent',
    contactId: cloudAgentId(definition),
    systemPrompt: definition.systemPrompt,
    xMd: definition.sourceSummary ?? definition.description ?? '',
    identityFiles: [],
    loadedTools,
    loadedSkills: definition.skills.map((skill) => skill.name),
    loadedPlugins,
    lastActivities: [definition.updatedAt],
    exposesIdentityFiles: false,
    exposesLoadedSkills: true,
    exposesLoadedTools: true,
    exposesLoadedPlugins: true,
    isOwned: true,
    isCollaborationRegistered: true,
    avatarSeed: definition.agentId,
    cloudAgentId: definition.agentId,
    cloudAgentAccessScope: definition.accessScope,
    cloudAgentProactive: definition.proactive,
    cloudAgentMentionPermissions: definition.mentionPermissions,
    cloudAgentOwnerAccountId: definition.ownerAccountId,
    cloudAgentDescription: definition.description,
    cloudAgentSourceSummary: definition.sourceSummary,
    cloudAgentBoundaries: definition.boundaries,
    cloudAgentResources: definition.resources,
    cloudAgentSkills: definition.skills,
  };
}

export type SharedCloudAgentSummary = {
  agentId: string;
  ownerAccountId: string;
  ownerDisplayName: string | null;
  accessScope: 'participant_conversations';
  name: string;
  role: string;
  description: string | null;
  updatedAt: string;
};

export function normalizeSharedCloudAgentSummary(value: unknown): SharedCloudAgentSummary | null {
  const record = objectRecord(value);
  if (!record) return null;
  const agentId = cleanText(record.agentId);
  const ownerAccountId = cleanText(record.ownerAccountId);
  const accessScope = cleanText(record.accessScope);
  const name = cleanText(record.name);
  const role = cleanText(record.role);
  const updatedAt = cleanText(record.updatedAt);
  if (!agentId || !ownerAccountId || accessScope !== 'participant_conversations' || !name || !role || !updatedAt) return null;
  return {
    agentId,
    ownerAccountId,
    ownerDisplayName: cleanNullableText(record.ownerDisplayName),
    accessScope: 'participant_conversations',
    name,
    role,
    description: cleanNullableText(record.description),
    updatedAt,
  };
}

export function cloudAgentDefinitionToSharedCloudAgentSummary(
  definition: CloudAgentDefinition,
  ownerDisplayName?: string | null,
): SharedCloudAgentSummary | null {
  if (definition.status !== 'active' || definition.accessScope !== 'participant_conversations') return null;
  return {
    agentId: definition.agentId,
    ownerAccountId: definition.ownerAccountId,
    ownerDisplayName: cleanNullableText(ownerDisplayName),
    accessScope: 'participant_conversations',
    name: definition.name,
    role: definition.role,
    description: definition.description,
    updatedAt: definition.updatedAt,
  };
}

function eventAgent(event: CloudSyncEvent): CloudAgentDefinition | null {
  const payload = objectRecord(event.payload);
  return normalizeCloudAgentDefinition(payload?.agent);
}

export function applyCloudAgentSyncEvents(
  current: Record<string, CloudAgentDefinition>,
  events: CloudSyncEvent[],
): Record<string, CloudAgentDefinition> {
  let next = current;
  for (const event of events) {
    if (event.eventType === 'agent.definition.upserted') {
      const agent = eventAgent(event);
      if (!agent || agent.status !== 'active') continue;
      next = { ...next, [agent.agentId]: agent };
      continue;
    }
    if (event.eventType === 'agent.definition.archived') {
      const agent = eventAgent(event);
      if (!agent) continue;
      const { [agent.agentId]: _removed, ...rest } = next;
      next = rest;
    }
  }
  return next;
}
