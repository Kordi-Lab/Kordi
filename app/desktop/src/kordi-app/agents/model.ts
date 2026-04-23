import type { Agent } from '../types';

export type AgentsPageProps = {
  agents: Agent[];
  activeAgentId: string;
  activeAgent?: Agent;
  onOpenAgent: (agentId: string) => void;
  getStatusBadgeClass: (value: string) => string;
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
  return !path.includes('://') && !path.includes(' • ');
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

export function buildIdentityFilePreview(agent: Agent, config: AgentConfigDraft, file: string) {
  if (file.endsWith('.json')) {
    return JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        loadedSkills: config.loadedSkills,
        loadedTools: agent.loadedTools,
        loadedPlugins: agent.loadedPlugins,
      },
      null,
      2,
    );
  }

  if (file.endsWith('identity.md')) {
    return [
      `# ${agent.name}`,
      '',
      `- id: ${agent.id}`,
      `- role: ${agent.role}`,
      `- contact: ${agent.contactId}`,
      `- messaging: ${agent.messaging}`,
      `- bridge: ${agent.bridgesConfig}`,
    ].join('\n');
  }

  if (file.endsWith('.toml')) {
    return [
      `agent_id = "${agent.id}"`,
      `model = "${agent.defaultModel}"`,
      `provider = "${agent.defaultProvider}"`,
      `scope = "private"`,
      `skills = [${config.loadedSkills.map((skill) => `"${skill}"`).join(', ')}]`,
    ].join('\n');
  }

  return [
    `# ${file.split('/').pop()}`,
    '',
    '## System prompt',
    config.systemPrompt,
    '',
    '## Loaded skills',
    ...(config.loadedSkills.length > 0 ? config.loadedSkills.map((skill) => `- ${skill}`) : ['- none']),
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
