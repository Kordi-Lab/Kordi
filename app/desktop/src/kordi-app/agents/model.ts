import type { CloudAgentAccessScope, CreateCloudAgentInput, UpdateCloudAgentInput } from '@/features/cloud/cloudAgentsClient';
import { newCanonicalAvatarSeed, type CanonicalAvatarMutation } from '@/features/cloud/canonicalAvatar';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { ComposerModelOption, ComposerProviderOption } from '../components';
import type { Agent } from '../types';

export type AgentsPageProps = {
  agents: Agent[];
  activeAgentId: string;
  activeAgent?: Agent;
  cloudAccountId?: string | null;
  localProfileAvatarSeed?: string | null;
  localProfileDisplayName?: string | null;
  localProfileImageUrl?: string | null;
  onOpenAgent: (agentId: string) => void;
  getStatusBadgeClass: (value: string) => string;
  chatModelOptions?: ComposerModelOption[];
  composerProviderOptions?: ComposerProviderOption[];
  defaultAgentRuntimeRoute?: DesktopChatMessageRoute | null;
  onUpdateAgentModelRouting?: (
    agent: Agent,
    values: {
      defaultModel?: string | null;
      defaultAuthProvider?: string | null;
      defaultAuthChoice?: string | null;
      fallbackModel?: string | null;
      fallbackAuthProvider?: string | null;
      fallbackAuthChoice?: string | null;
      thinking?: string | null;
    },
  ) => Promise<void> | void;
  onMessageAgent?: (agent: Agent) => void;
  onOpenAgentReachoutSession?: (sessionId: string) => void;
  onOpenAgentBuilderSession?: (sessionId: string) => void;
  onOpenAuthSettings?: () => void;
  onCreateCloudAgent?: (input: CreateCloudAgentInput) => Promise<Agent>;
  onUpdateCloudAgent?: (agent: Agent, input: UpdateCloudAgentInput) => Promise<Agent> | Promise<void> | Agent | void;
  onArchiveCloudAgent?: (agent: Agent) => Promise<void>;
  onRenameLocalAgent?: (name: string) => Promise<void> | void;
  onUpdateLocalAgentAvatar?: (mutation: CanonicalAvatarMutation) => Promise<void> | void;
  onSetAgentSkillEnabled?: (agent: Agent, skill: string, enabled: boolean) => Promise<void> | void;
};

export function cloudAgentAvatarControls(
  agent: Agent,
  update?: AgentsPageProps['onUpdateCloudAgent'],
) {
  if (!agent.cloudAgentId || !update) return {};
  return {
    onUpload: async (uploadedAsset: string) => {
      await update(agent, {
        avatarMutation: {
          action: 'upload',
          uploadedAsset,
          expectedVersion: agent.cloudAgentAvatarVersion,
        },
      });
    },
    onGenerate: async () => {
      await update(agent, {
        avatarMutation: {
          action: 'regenerate',
          seed: newCanonicalAvatarSeed(),
          expectedVersion: agent.cloudAgentAvatarVersion,
        },
      });
    },
    generateLabel: 'Random avatar',
  };
}

export type AgentConfigDraft = {
  systemPrompt: string;
  loadedSkills: string[];
};

export type AgentStudioConfigDraft = AgentConfigDraft & {
  loadedTools: string[];
  loadedPlugins: string[];
};

export type AgentStudioCapabilityKind = 'skill' | 'tool' | 'plugin';

export type FactoryArtifactKind = 'agent' | 'skill' | 'tool' | 'plugin';

export type FactorySection = 'build' | 'agents' | 'library';

export type FactoryLibrarySection = 'skill' | 'tool' | 'plugin';

export type FactoryReturnContext = {
  section: Exclude<FactorySection, 'build'>;
  librarySection?: FactoryLibrarySection;
  selectedId: string | null;
};

export type FactoryBuildRoute = {
  targetKey: string;
  sessionId: string | null;
  artifactKind: FactoryArtifactKind;
  artifactId: string | null;
  returnContext: FactoryReturnContext | null;
};

export type FactoryLibraryArtifact = {
  id: string;
  kind: FactoryLibrarySection;
  name: string;
  description: string;
  status: string;
  usedBy: string[];
};

export function agentBuilderTargetKey(accountId: string | null | undefined, target: string) {
  const normalizedAccountId = accountId?.trim();
  const scope = normalizedAccountId
    ? `account:${encodeURIComponent(normalizedAccountId)}`
    : 'device';
  return `${scope}:${target}`;
}

export function factoryArtifactTargetKey(
  accountId: string | null | undefined,
  kind: FactoryArtifactKind,
  artifactId: string,
) {
  return agentBuilderTargetKey(accountId, `${kind}:${encodeURIComponent(artifactId)}`);
}

export function createFactoryBuildTargetKey(
  accountId: string | null | undefined,
  kind: FactoryArtifactKind,
  buildId: string,
) {
  return agentBuilderTargetKey(accountId, `create:${kind}:${encodeURIComponent(buildId)}`);
}

function unscopedFactoryTarget(targetKey: string) {
  if (targetKey.startsWith('device:')) return targetKey.slice('device:'.length);
  if (!targetKey.startsWith('account:')) return targetKey;
  const accountSeparator = targetKey.indexOf(':', 'account:'.length);
  return accountSeparator >= 0 ? targetKey.slice(accountSeparator + 1) : targetKey;
}

export function factoryArtifactIdentityFromTarget(targetKey: string) {
  const target = unscopedFactoryTarget(targetKey);
  for (const kind of ['agent', 'skill', 'tool', 'plugin'] as const) {
    const marker = `${kind}:`;
    if (target.startsWith(marker)) {
      const encodedId = target.slice(marker.length);
      try {
        return { kind, id: decodeURIComponent(encodedId) };
      } catch {
        return { kind, id: encodedId };
      }
    }
  }
  return null;
}

export function factoryBuildIdentityFromTarget(targetKey: string) {
  const target = unscopedFactoryTarget(targetKey);
  for (const kind of ['agent', 'skill', 'tool', 'plugin'] as const) {
    if (target.startsWith(`create:${kind}:`)) return { kind, artifactId: null };
  }
  const artifact = factoryArtifactIdentityFromTarget(targetKey);
  return artifact ? { kind: artifact.kind, artifactId: artifact.id } : null;
}

export type AgentStudioTab = 'blueprint' | 'capabilities' | 'files' | 'runs' | 'history';

export function skillLibraryFileDisplay(path: string) {
  const segments = path.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? path;
  const parent = segments.length > 1 ? segments.slice(0, -1).join('/') : null;
  return { name, parent };
}

export function visibleAgentStudioTabIds(creating: boolean, artifactKind: FactoryArtifactKind): AgentStudioTab[] {
  if (creating && artifactKind !== 'agent') return ['files', 'runs', 'history'];
  return ['blueprint', 'capabilities', 'runs', 'history'];
}

export type AgentEditHistoryEntry = {
  path: string;
  action: string;
  timestamp: string;
};

export type PersistedAgentConfig = AgentConfigDraft & {
  loadedTools: string[];
  loadedPlugins: string[];
  editHistory: AgentEditHistoryEntry[];
};

export type AgentSaveFeedback = {
  tone: 'idle' | 'info' | 'success' | 'error';
  text: string;
};

export const AGENT_CONFIG_STORAGE_KEY = 'kordi.agent-config-drafts.v1';

export function cloudAgentAccessLabel(scope: CloudAgentAccessScope | undefined) {
  return scope === 'participant_conversations'
    ? 'People in my chats can mention it'
    : 'Only me';
}

export function cloudAgentAccessDescription(scope: CloudAgentAccessScope | undefined) {
  return scope === 'participant_conversations'
    ? 'People in contact and group chats that include you can @mention this agent.'
    : 'Only you can use this agent. It stays synced privately to your Cloud account.';
}

export function buildAgentDraft(agent: Agent): AgentConfigDraft {
  return {
    systemPrompt: agent.systemPrompt,
    loadedSkills: agent.loadedSkills,
  };
}

export function buildAgentStudioDraft(agent: Agent): AgentStudioConfigDraft {
  return {
    ...buildAgentDraft(agent),
    loadedTools: agent.loadedTools,
    loadedPlugins: agent.loadedPlugins,
  };
}

export function buildPersistedAgentConfig(agent: Agent): PersistedAgentConfig {
  return {
    ...buildAgentStudioDraft(agent),
    editHistory: [],
  };
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...right].sort((a, b) => a.localeCompare(b));
  return normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

export function agentStudioConfigChanges(draft: AgentStudioConfigDraft, persisted: PersistedAgentConfig) {
  const changes: Array<{ key: 'prompt' | 'skills' | 'tools' | 'plugins'; label: string; detail: string }> = [];
  if (draft.systemPrompt !== persisted.systemPrompt) {
    changes.push({ key: 'prompt', label: 'System prompt updated', detail: 'prompt' });
  }
  if (!sameStringList(draft.loadedSkills, persisted.loadedSkills)) {
    changes.push({ key: 'skills', label: 'Skill selection updated', detail: `${draft.loadedSkills.length} loaded` });
  }
  if (!sameStringList(draft.loadedTools, persisted.loadedTools)) {
    changes.push({ key: 'tools', label: 'Tool selection updated', detail: `${draft.loadedTools.length} loaded` });
  }
  if (!sameStringList(draft.loadedPlugins, persisted.loadedPlugins)) {
    changes.push({ key: 'plugins', label: 'Plugin selection updated', detail: `${draft.loadedPlugins.length} loaded` });
  }
  return changes;
}

export function publishableLocalAgentConfigChanges(
  changes: ReturnType<typeof agentStudioConfigChanges>,
  canPersistFiles: boolean,
  canToggleRuntimeSkills: boolean,
) {
  return changes.filter((change) => (
    canPersistFiles || (change.key === 'skills' && canToggleRuntimeSkills)
  ));
}

export function getAgentConfigPath(agent: Agent) {
  return agent.identityFiles.find((file) => file.endsWith('config.json')) ?? null;
}

export function isRepoFilePath(path: string) {
  return path.trim().length > 0 && !path.startsWith('/') && !path.includes('://') && !path.includes(' • ');
}

export function isEditableWorkspaceTextFile(path: string) {
  if (!isRepoFilePath(path)) return false;
  const name = path.split('/').pop();
  return name === 'AGENTS.md' || name === 'CLAUDE.md' || name === 'identity.md' || name === 'config.json' || name === 'settings.json';
}

export function formatHistoryPath(path: string) {
  return path.split('/').join(' › ');
}

export function getAgentInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function buildUnavailableFilePreview(agent: Agent, file?: string | null) {
  return [
    `# ${agent.name}`,
    '',
    file ? `No content is available for ${file}.` : 'No files are available for this agent.',
  ].join('\n');
}

export function parsePersistedAgentConfig(raw: string, agent: Agent): PersistedAgentConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedAgentConfig> & { editHistory?: unknown };
    return {
      systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : agent.systemPrompt,
      loadedSkills: Array.isArray(parsed.loadedSkills)
        ? parsed.loadedSkills.filter((entry): entry is string => typeof entry === 'string')
        : agent.loadedSkills,
      loadedTools: Array.isArray(parsed.loadedTools)
        ? parsed.loadedTools.filter((entry): entry is string => typeof entry === 'string')
        : agent.loadedTools,
      loadedPlugins: Array.isArray(parsed.loadedPlugins)
        ? parsed.loadedPlugins.filter((entry): entry is string => typeof entry === 'string')
        : agent.loadedPlugins,
      editHistory: Array.isArray(parsed.editHistory)
        ? parsed.editHistory.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return [];
            const record = entry as Record<string, unknown>;
            if (typeof record.path !== 'string' || typeof record.action !== 'string' || typeof record.timestamp !== 'string') {
              return [];
            }
            return [{ path: record.path, action: record.action, timestamp: record.timestamp } satisfies AgentEditHistoryEntry];
          })
        : [],
    };
  } catch {
    return buildPersistedAgentConfig(agent);
  }
}

export function readStoredAgentDrafts() {
  if (typeof window === 'undefined') return {} as Record<string, Partial<AgentStudioConfigDraft>>;

  try {
    const raw = window.localStorage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return {} as Record<string, Partial<AgentStudioConfigDraft>>;
    const parsed = JSON.parse(raw) as Record<string, Partial<AgentStudioConfigDraft>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([agentId, draft]) => [
        agentId,
        {
          systemPrompt: typeof draft.systemPrompt === 'string' ? draft.systemPrompt : undefined,
          loadedSkills: Array.isArray(draft.loadedSkills)
            ? draft.loadedSkills.filter((entry): entry is string => typeof entry === 'string')
            : undefined,
          loadedTools: Array.isArray(draft.loadedTools)
            ? draft.loadedTools.filter((entry): entry is string => typeof entry === 'string')
            : undefined,
          loadedPlugins: Array.isArray(draft.loadedPlugins)
            ? draft.loadedPlugins.filter((entry): entry is string => typeof entry === 'string')
            : undefined,
        },
      ]),
    );
  } catch {
    return {} as Record<string, Partial<AgentStudioConfigDraft>>;
  }
}
