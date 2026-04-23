import { useEffect, useMemo, useState } from 'react';
import { readDesktopWorkspaceTextFile, writeDesktopWorkspaceTextFile } from '@/lib/desktop';
import type { Agent } from '../types';
import { AgentDetailPane, AgentsSidebar } from './components';
import {
  AGENT_CONFIG_STORAGE_KEY,
  buildAgentDraft,
  buildIdentityFilePreview,
  buildPersistedAgentConfig,
  getAgentConfigPath,
  isRepoFilePath,
  parsePersistedAgentConfig,
  readStoredAgentDrafts,
  type AgentConfigDraft,
  type AgentSaveFeedback,
  type AgentsPageProps,
  type PersistedAgentConfig,
} from './model';

export function AgentsPage({
  agents,
  activeAgentId,
  activeAgent,
  onOpenAgent,
  getStatusBadgeClass,
  onMessageAgent,
}: AgentsPageProps) {
  const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentConfigDraft>>(() => readStoredAgentDrafts());
  const [persistedAgentConfigs, setPersistedAgentConfigs] = useState<Record<string, PersistedAgentConfig>>({});
  const [selectedIdentityFileByAgentId, setSelectedIdentityFileByAgentId] = useState<Record<string, string>>({});
  const [editingSectionByAgentId, setEditingSectionByAgentId] = useState<Record<string, 'prompt' | 'skills' | null>>({});
  const [saveFeedbackByAgentId, setSaveFeedbackByAgentId] = useState<Record<string, AgentSaveFeedback>>({});
  const [activeFilePreview, setActiveFilePreview] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string }>({ status: 'idle', text: '' });

  const canUseNativeFileAccess = typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';

  const availableSkills = useMemo(
    () => Array.from(new Set(agents.flatMap((agent) => agent.loadedSkills))).sort((left, right) => left.localeCompare(right)),
    [agents],
  );

  const agentConfigs = useMemo(
    () =>
      Object.fromEntries(
        agents.map((agent) => {
          const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);
          return [
            agent.id,
            {
              systemPrompt: agentDrafts[agent.id]?.systemPrompt ?? persisted.systemPrompt,
              loadedSkills: agentDrafts[agent.id]?.loadedSkills ?? persisted.loadedSkills,
            },
          ];
        }),
      ) as Record<string, AgentConfigDraft>,
    [agentDrafts, agents, persistedAgentConfigs],
  );

  const activeAgentConfig = activeAgent ? agentConfigs[activeAgent.id] ?? buildAgentDraft(activeAgent) : null;
  const activePersistedConfig = activeAgent ? persistedAgentConfigs[activeAgent.id] ?? buildPersistedAgentConfig(activeAgent) : null;
  const activeIdentityFile = activeAgent
    ? selectedIdentityFileByAgentId[activeAgent.id] ?? activeAgent.identityFiles[0] ?? null
    : null;
  const activeConfigPath = activeAgent ? getAgentConfigPath(activeAgent) : null;
  const activeSaveFeedback = activeAgent
    ? saveFeedbackByAgentId[activeAgent.id] ?? { tone: 'idle', text: activeConfigPath ? `Loaded from ${activeConfigPath}` : 'Using preview data' }
    : null;
  const activeEditingSection = activeAgent ? editingSectionByAgentId[activeAgent.id] ?? null : null;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(agentDrafts));
  }, [agentDrafts]);

  useEffect(() => {
    let cancelled = false;

    const loadPersistedConfigs = async () => {
      const nextEntries = await Promise.all(
        agents.map(async (agent) => {
          const configPath = getAgentConfigPath(agent);
          if (!canUseNativeFileAccess || !configPath || !isRepoFilePath(configPath)) {
            return [agent.id, buildPersistedAgentConfig(agent)] as const;
          }

          try {
            const raw = await readDesktopWorkspaceTextFile(configPath);
            return [agent.id, parsePersistedAgentConfig(raw, agent)] as const;
          } catch {
            return [agent.id, buildPersistedAgentConfig(agent)] as const;
          }
        }),
      );

      if (!cancelled) {
        setPersistedAgentConfigs(Object.fromEntries(nextEntries));
      }
    };

    void loadPersistedConfigs();
    return () => {
      cancelled = true;
    };
  }, [agents, canUseNativeFileAccess]);

  useEffect(() => {
    let cancelled = false;

    const loadActiveFilePreview = async () => {
      if (!activeAgent || !activeAgentConfig || !activeIdentityFile) {
        if (!cancelled) setActiveFilePreview({ status: 'idle', text: '' });
        return;
      }

      if (canUseNativeFileAccess && isRepoFilePath(activeIdentityFile)) {
        setActiveFilePreview({ status: 'loading', text: '' });
        try {
          const raw = await readDesktopWorkspaceTextFile(activeIdentityFile);
          if (!cancelled) setActiveFilePreview({ status: 'ready', text: raw });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to load file preview';
          if (!cancelled) {
            setActiveFilePreview({
              status: 'error',
              text: buildIdentityFilePreview(activeAgent, activeAgentConfig, activeIdentityFile),
              error: message,
            });
          }
          return;
        }
      }

      if (!cancelled) {
        setActiveFilePreview({
          status: 'ready',
          text: buildIdentityFilePreview(activeAgent, activeAgentConfig, activeIdentityFile),
        });
      }
    };

    void loadActiveFilePreview();
    return () => {
      cancelled = true;
    };
  }, [activeAgent, activeAgentConfig, activeIdentityFile, canUseNativeFileAccess]);

  const updateAgentDraft = (agentId: string, apply: (current: AgentConfigDraft) => AgentConfigDraft) => {
    setAgentDrafts((current) => {
      const fallbackAgent = agents.find((agent) => agent.id === agentId) ?? activeAgent ?? agents[0];
      const baseline = current[agentId] ?? buildAgentDraft(fallbackAgent);
      return {
        ...current,
        [agentId]: apply(baseline),
      };
    });
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agentId]: { tone: 'info', text: 'Unsaved changes' },
    }));
  };

  const resetAgentDraft = (agent: Agent) => {
    const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);
    const configPath = getAgentConfigPath(agent);

    setAgentDrafts((current) => ({
      ...current,
      [agent.id]: {
        systemPrompt: persisted.systemPrompt,
        loadedSkills: persisted.loadedSkills,
      },
    }));
    setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'info', text: configPath ? `Reverted to ${configPath}` : 'Reverted to saved values' },
    }));
  };

  const saveAgentConfig = async (agent: Agent, section: 'prompt' | 'skills') => {
    const configPath = getAgentConfigPath(agent);
    const draft = agentConfigs[agent.id] ?? buildAgentDraft(agent);
    const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);

    if (!canUseNativeFileAccess || !configPath || !isRepoFilePath(configPath)) {
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'success', text: `Saved ${section} locally` },
      }));
      return;
    }

    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'info', text: `Saving to ${configPath}…` },
    }));

    const nextPersisted: PersistedAgentConfig = {
      systemPrompt: draft.systemPrompt,
      loadedSkills: draft.loadedSkills,
      loadedTools: persisted.loadedTools,
      loadedPlugins: persisted.loadedPlugins,
      editHistory: [
        {
          path: configPath,
          action: section === 'prompt' ? 'Saved system prompt' : 'Saved loaded skills',
          timestamp: new Date().toLocaleString(),
        },
        ...persisted.editHistory,
      ].slice(0, 12),
    };

    try {
      await writeDesktopWorkspaceTextFile(configPath, `${JSON.stringify(nextPersisted, null, 2)}\n`);
      setPersistedAgentConfigs((current) => ({ ...current, [agent.id]: nextPersisted }));
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'success', text: `${section === 'prompt' ? 'System prompt' : 'Skills'} saved to ${configPath}` },
      }));
      if (activeIdentityFile === configPath) {
        setActiveFilePreview({ status: 'ready', text: `${JSON.stringify(nextPersisted, null, 2)}\n` });
      }
    } catch (error) {
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'error', text: error instanceof Error ? error.message : 'Unable to save agent config' },
      }));
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 p-4">
      <div className="grid h-full min-h-0 w-full gap-px overflow-hidden rounded-[22px] border border-white/8 bg-white/[0.04] xl:grid-cols-[310px_minmax(0,1fr)]">
        <AgentsSidebar
          agents={agents}
          activeAgentId={activeAgentId}
          agentConfigs={agentConfigs}
          getStatusBadgeClass={getStatusBadgeClass}
          onOpenAgent={onOpenAgent}
        />
        <AgentDetailPane
          activeAgent={activeAgent}
          activeAgentConfig={activeAgentConfig}
          activePersistedConfig={activePersistedConfig}
          activeIdentityFile={activeIdentityFile}
          activeFilePreview={activeFilePreview}
          activeSaveFeedback={activeSaveFeedback}
          activeEditingSection={activeEditingSection}
          availableSkills={availableSkills}
          onReset={resetAgentDraft}
          onMessage={
            onMessageAgent && activeAgent && activeAgentConfig
              ? () => onMessageAgent({ ...activeAgent, ...activeAgentConfig, loadedSkills: activeAgentConfig.loadedSkills })
              : undefined
          }
          onStartEditing={(agentId, section) => setEditingSectionByAgentId((current) => ({ ...current, [agentId]: section }))}
          onSave={(agent, section) => void saveAgentConfig(agent, section)}
          onCancelEditing={resetAgentDraft}
          onPromptChange={(agentId, value) => updateAgentDraft(agentId, (current) => ({ ...current, systemPrompt: value }))}
          onToggleSkill={(agentId, skill, selected) =>
            updateAgentDraft(agentId, (current) => ({
              ...current,
              loadedSkills: selected
                ? current.loadedSkills.filter((entry) => entry !== skill)
                : [...current.loadedSkills, skill].sort((left, right) => left.localeCompare(right)),
            }))
          }
          onSelectIdentityFile={(agentId, file) => setSelectedIdentityFileByAgentId((current) => ({ ...current, [agentId]: file }))}
        />
      </div>
    </div>
  );
}
