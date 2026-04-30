import type { ComposerModelOption, ComposerProviderOption } from '../components';
import type { Agent } from '../types';

export type AgentsPageProps = {
  agents: Agent[];
  activeAgentId: string;
  activeAgent?: Agent;
  onOpenAgent: (agentId: string) => void;
  getStatusBadgeClass: (value: string) => string;
  chatModelOptions?: ComposerModelOption[];
  composerProviderOptions?: ComposerProviderOption[];
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
};

export type AgentConfigDraft = {
  systemPrompt: string;
  loadedSkills: string[];
};

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

export function buildAgentDraft(agent: Agent): AgentConfigDraft {
  return {
    systemPrompt: agent.systemPrompt,
    loadedSkills: agent.loadedSkills,
  };
}

export function buildPersistedAgentConfig(agent: Agent): PersistedAgentConfig {
  return {
    ...buildAgentDraft(agent),
    loadedTools: agent.loadedTools,
    loadedPlugins: agent.loadedPlugins,
    editHistory: [],
  };
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
    file ? `No real file contents are available for: ${file}` : 'No real identity files are exposed for this agent.',
    '',
    'The desktop UI is intentionally avoiding generated placeholder content here.',
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
  if (typeof window === 'undefined') return {} as Record<string, AgentConfigDraft>;

  try {
    const raw = window.localStorage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return {} as Record<string, AgentConfigDraft>;
    const parsed = JSON.parse(raw) as Record<string, Partial<AgentConfigDraft>>;
    return Object.fromEntries(
      Object.entries(parsed).map(([agentId, draft]) => [
        agentId,
        {
          systemPrompt: typeof draft.systemPrompt === 'string' ? draft.systemPrompt : '',
          loadedSkills: Array.isArray(draft.loadedSkills)
            ? draft.loadedSkills.filter((entry): entry is string => typeof entry === 'string')
            : [],
        },
      ]),
    );
  } catch {
    return {} as Record<string, AgentConfigDraft>;
  }
}
