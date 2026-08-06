import { useCallback, useEffect, useMemo, useState } from 'react';
import { readDesktopWorkspaceTextFile, writeDesktopWorkspaceTextFile } from '@/lib/desktop';
import type { Agent } from '../types';
import {
  AGENT_CONFIG_STORAGE_KEY,
  agentStudioConfigChanges,
  buildAgentStudioDraft,
  buildUnavailableFilePreview,
  buildPersistedAgentConfig,
  getAgentConfigPath,
  isEditableWorkspaceTextFile,
  isRepoFilePath,
  parsePersistedAgentConfig,
  readStoredAgentDrafts,
  type AgentStudioConfigDraft,
  type AgentSaveFeedback,
  type PersistedAgentConfig,
} from './model';

const EMPTY_FILE_PREVIEW = { status: 'idle' as const, text: '' };

type AgentDetailTarget =
  | { kind: 'prompt' }
  | { kind: 'file'; path: string };

export function useAgentsPageModel(agents: Agent[], activeAgent?: Agent) {
  const [agentDrafts, setAgentDrafts] = useState<Record<string, Partial<AgentStudioConfigDraft>>>(() => readStoredAgentDrafts());
  const [persistedAgentConfigs, setPersistedAgentConfigs] = useState<Record<string, PersistedAgentConfig>>({});
  const [selectedDetailByAgentId, setSelectedDetailByAgentId] = useState<Record<string, AgentDetailTarget>>({});
  const [editingSectionByAgentId, setEditingSectionByAgentId] = useState<Record<string, 'prompt' | 'skills' | null>>({});
  const [saveFeedbackByAgentId, setSaveFeedbackByAgentId] = useState<Record<string, AgentSaveFeedback>>({});
  const [activeFilePreview, setActiveFilePreview] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error?: string }>(EMPTY_FILE_PREVIEW);
  const [fileDraftsByPath, setFileDraftsByPath] = useState<Record<string, string>>({});
  const [fileSaveFeedbackByPath, setFileSaveFeedbackByPath] = useState<Record<string, AgentSaveFeedback>>({});
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null);

  const canUseNativeFileAccess = typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';

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
              loadedTools: agentDrafts[agent.id]?.loadedTools ?? persisted.loadedTools,
              loadedPlugins: agentDrafts[agent.id]?.loadedPlugins ?? persisted.loadedPlugins,
            },
          ];
        }),
      ) as Record<string, AgentStudioConfigDraft>,
    [agentDrafts, agents, persistedAgentConfigs],
  );

  const activeAgentConfig = activeAgent ? agentConfigs[activeAgent.id] ?? buildAgentStudioDraft(activeAgent) : null;
  const activePersistedConfig = activeAgent ? persistedAgentConfigs[activeAgent.id] ?? buildPersistedAgentConfig(activeAgent) : null;
  const availableSkills = useMemo(
    () =>
      Array.from(
        new Set([
          ...(activePersistedConfig?.loadedSkills ?? []),
          ...(activeAgentConfig?.loadedSkills ?? []),
          ...agents.flatMap((agent) => agent.loadedSkills),
        ]),
      ).sort((left, right) => left.localeCompare(right)),
    [activeAgentConfig?.loadedSkills, activePersistedConfig?.loadedSkills, agents],
  );
  const availableTools = useMemo(
    () => Array.from(new Set([
      ...(activePersistedConfig?.loadedTools ?? []),
      ...(activeAgentConfig?.loadedTools ?? []),
      ...agents.flatMap((agent) => agent.loadedTools),
    ])).sort((left, right) => left.localeCompare(right)),
    [activeAgentConfig?.loadedTools, activePersistedConfig?.loadedTools, agents],
  );
  const availablePlugins = useMemo(
    () => Array.from(new Set([
      ...(activePersistedConfig?.loadedPlugins ?? []),
      ...(activeAgentConfig?.loadedPlugins ?? []),
      ...agents.flatMap((agent) => agent.loadedPlugins),
    ])).sort((left, right) => left.localeCompare(right)),
    [activeAgentConfig?.loadedPlugins, activePersistedConfig?.loadedPlugins, agents],
  );
  const activeDraftChanges = activeAgentConfig && activePersistedConfig
    ? agentStudioConfigChanges(activeAgentConfig, activePersistedConfig)
    : [];
  const activeDetail = activeAgent ? selectedDetailByAgentId[activeAgent.id] ?? { kind: 'prompt' as const } : null;
  const activeIdentityFile = activeDetail?.kind === 'file' ? activeDetail.path : null;
  const activeConfigPath = activeAgent ? getAgentConfigPath(activeAgent) : null;
  const activeSaveFeedback = activeAgent ? saveFeedbackByAgentId[activeAgent.id] ?? null : null;
  const activeEditingSection = activeAgent ? editingSectionByAgentId[activeAgent.id] ?? null : null;
  const activeFileCanEdit = Boolean(activeIdentityFile && canUseNativeFileAccess && isEditableWorkspaceTextFile(activeIdentityFile));
  const activeFileIsEditing = Boolean(activeIdentityFile && editingFilePath === activeIdentityFile && activeFileCanEdit);
  const activeFileDraft = activeIdentityFile ? fileDraftsByPath[activeIdentityFile] ?? activeFilePreview.text : '';
  const activeFileSaveFeedback = activeIdentityFile ? fileSaveFeedbackByPath[activeIdentityFile] ?? null : null;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(agentDrafts));
    } catch {
      // Keep the in-memory draft usable if browser storage is unavailable.
    }
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
        if (!cancelled) setActiveFilePreview(EMPTY_FILE_PREVIEW);
        return;
      }

      if (canUseNativeFileAccess && isRepoFilePath(activeIdentityFile)) {
        setActiveFilePreview({ status: 'loading', text: '' });
        try {
          const raw = await readDesktopWorkspaceTextFile(activeIdentityFile);
          if (!cancelled) setActiveFilePreview({ status: 'ready', text: raw });
          return;
        } catch (error) {
          if (!cancelled) {
            setActiveFilePreview({
              status: 'error',
              text: buildUnavailableFilePreview(activeAgent, activeIdentityFile),
              error: error instanceof Error ? error.message : 'Unable to load file preview',
            });
          }
          return;
        }
      }

      if (!cancelled) {
        setActiveFilePreview({
          status: 'ready',
          text: buildUnavailableFilePreview(activeAgent, activeIdentityFile),
        });
      }
    };

    void loadActiveFilePreview();
    return () => {
      cancelled = true;
    };
  }, [activeAgent, activeAgentConfig, activeIdentityFile, canUseNativeFileAccess]);

  const updateAgentDraft = useCallback((agentId: string, apply: (current: AgentStudioConfigDraft) => AgentStudioConfigDraft) => {
    setAgentDrafts((current) => {
      const fallbackAgent = agents.find((agent) => agent.id === agentId) ?? activeAgent ?? agents[0];
      if (!fallbackAgent) {
        return current;
      }
      const persisted = persistedAgentConfigs[agentId] ?? buildPersistedAgentConfig(fallbackAgent);
      const stored = current[agentId];
      const baseline: AgentStudioConfigDraft = {
        systemPrompt: stored?.systemPrompt ?? persisted.systemPrompt,
        loadedSkills: stored?.loadedSkills ?? persisted.loadedSkills,
        loadedTools: stored?.loadedTools ?? persisted.loadedTools,
        loadedPlugins: stored?.loadedPlugins ?? persisted.loadedPlugins,
      };
      return {
        ...current,
        [agentId]: apply(baseline),
      };
    });
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agentId]: { tone: 'info', text: 'Unsaved changes' },
    }));
  }, [activeAgent, agents, persistedAgentConfigs]);

  const replaceAgentDraft = useCallback((agentId: string, draft: AgentStudioConfigDraft) => {
    updateAgentDraft(agentId, () => draft);
  }, [updateAgentDraft]);

  const resetAgentDraft = (agent: Agent) => {
    const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);
    const configPath = getAgentConfigPath(agent);

    setAgentDrafts((current) => ({
      ...current,
      [agent.id]: {
        systemPrompt: persisted.systemPrompt,
        loadedSkills: persisted.loadedSkills,
        loadedTools: persisted.loadedTools,
        loadedPlugins: persisted.loadedPlugins,
      },
    }));
    setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'info', text: configPath ? `Reverted to ${configPath}` : 'Reverted to saved values' },
    }));
  };

  const saveAgentConfig = async (
    agent: Agent,
    section: 'prompt' | 'skills' | 'tools' | 'plugins' | 'all',
    draftOverride?: AgentStudioConfigDraft,
  ) => {
    const configPath = getAgentConfigPath(agent);
    const draft = draftOverride ?? agentConfigs[agent.id] ?? buildAgentStudioDraft(agent);
    const persisted = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);

    if (!canUseNativeFileAccess || !configPath || !isRepoFilePath(configPath)) {
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'error', text: 'This runtime does not expose a writable agent config file.' },
      }));
      throw new Error('This runtime does not expose a writable agent config file.');
    }

    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'info', text: `Saving to ${configPath}…` },
    }));

    const nextPersisted: PersistedAgentConfig = {
      systemPrompt: draft.systemPrompt,
      loadedSkills: draft.loadedSkills,
      loadedTools: draft.loadedTools,
      loadedPlugins: draft.loadedPlugins,
      editHistory: [
        {
          path: configPath,
          action: section === 'all'
            ? 'Published Factory draft'
            : section === 'prompt'
              ? 'Saved system prompt'
              : `Saved loaded ${section}`,
          timestamp: new Date().toLocaleString(),
        },
        ...persisted.editHistory,
      ].slice(0, 12),
    };
    const nextRaw = `${JSON.stringify(nextPersisted, null, 2)}\n`;

    try {
      await writeDesktopWorkspaceTextFile(configPath, nextRaw);
      setPersistedAgentConfigs((current) => ({ ...current, [agent.id]: nextPersisted }));
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'success', text: `${section === 'all' ? 'Factory draft' : section === 'prompt' ? 'System prompt' : section} saved to ${configPath}` },
      }));
      if (activeIdentityFile === configPath) {
        setActiveFilePreview({ status: 'ready', text: nextRaw });
        setFileDraftsByPath((current) => (current[configPath] ? { ...current, [configPath]: nextRaw } : current));
      }
    } catch (error) {
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'error', text: error instanceof Error ? error.message : 'Unable to save agent config' },
      }));
    }
  };

  const startFileEditing = () => {
    if (!activeIdentityFile || !activeFileCanEdit) return;
    setFileDraftsByPath((current) => ({
      ...current,
      [activeIdentityFile]: current[activeIdentityFile] ?? activeFilePreview.text,
    }));
    setEditingFilePath(activeIdentityFile);
    setFileSaveFeedbackByPath((current) => ({
      ...current,
      [activeIdentityFile]: { tone: 'info', text: 'Editing file contents' },
    }));
  };

  const cancelFileEditing = () => {
    if (!activeIdentityFile) return;
    setEditingFilePath((current) => (current === activeIdentityFile ? null : current));
    setFileDraftsByPath((current) => {
      const next = { ...current };
      delete next[activeIdentityFile];
      return next;
    });
    setFileSaveFeedbackByPath((current) => ({
      ...current,
      [activeIdentityFile]: { tone: 'info', text: 'Reverted file draft' },
    }));
  };

  const updateActiveFileDraft = (value: string) => {
    if (!activeIdentityFile) return;
    setFileDraftsByPath((current) => ({
      ...current,
      [activeIdentityFile]: value,
    }));
    setFileSaveFeedbackByPath((current) => ({
      ...current,
      [activeIdentityFile]: { tone: 'info', text: 'Unsaved file changes' },
    }));
  };

  const saveActiveFile = async () => {
    if (!activeAgent || !activeIdentityFile || !activeFileCanEdit) return;

    const nextRaw = fileDraftsByPath[activeIdentityFile] ?? activeFilePreview.text;
    setFileSaveFeedbackByPath((current) => ({
      ...current,
      [activeIdentityFile]: { tone: 'info', text: `Saving to ${activeIdentityFile}…` },
    }));

    try {
      await writeDesktopWorkspaceTextFile(activeIdentityFile, nextRaw);
      setActiveFilePreview({ status: 'ready', text: nextRaw });
      setEditingFilePath(null);
      setFileSaveFeedbackByPath((current) => ({
        ...current,
        [activeIdentityFile]: { tone: 'success', text: `Saved ${activeIdentityFile}` },
      }));

      if (activeIdentityFile === activeConfigPath) {
        const nextPersisted = parsePersistedAgentConfig(nextRaw, activeAgent);
        setPersistedAgentConfigs((current) => ({
          ...current,
          [activeAgent.id]: nextPersisted,
        }));
        setAgentDrafts((current) => ({
          ...current,
          [activeAgent.id]: {
            systemPrompt: nextPersisted.systemPrompt,
            loadedSkills: nextPersisted.loadedSkills,
            loadedTools: nextPersisted.loadedTools,
            loadedPlugins: nextPersisted.loadedPlugins,
          },
        }));
        setSaveFeedbackByAgentId((current) => ({
          ...current,
          [activeAgent.id]: { tone: 'success', text: `Loaded updated config from ${activeIdentityFile}` },
        }));
      }
    } catch (error) {
      setFileSaveFeedbackByPath((current) => ({
        ...current,
        [activeIdentityFile]: { tone: 'error', text: error instanceof Error ? error.message : 'Unable to save file' },
      }));
    }
  };

  const markAgentDraftPublished = (agent: Agent, draft: AgentStudioConfigDraft, action = 'Published Factory draft') => {
    const previous = persistedAgentConfigs[agent.id] ?? buildPersistedAgentConfig(agent);
    const path = getAgentConfigPath(agent) ?? (agent.cloudAgentId ? 'Synchronized agent' : 'Local runtime');
    const nextPersisted: PersistedAgentConfig = {
      ...draft,
      editHistory: [
        { path, action, timestamp: new Date().toLocaleString() },
        ...previous.editHistory,
      ].slice(0, 12),
    };
    setPersistedAgentConfigs((current) => ({ ...current, [agent.id]: nextPersisted }));
    setAgentDrafts((current) => ({ ...current, [agent.id]: draft }));
    setSaveFeedbackByAgentId((current) => ({
      ...current,
      [agent.id]: { tone: 'success', text: `${agent.name} is published and ready.` },
    }));
  };

  return {
    agentConfigs,
    activeAgentConfig,
    activePersistedConfig,
    activeDetail,
    activeIdentityFile,
    activeSaveFeedback,
    activeEditingSection,
    activeFilePreview,
    activeFileDraft,
    activeFileCanEdit,
    activeFileIsEditing,
    activeFileSaveFeedback,
    availableSkills,
    availableTools,
    availablePlugins,
    activeDraftChanges,
    resetAgentDraft,
    saveAgentConfig,
    markAgentDraftPublished,
    saveActiveFile,
    startEditing: (agentId: string, section: 'prompt' | 'skills') => setEditingSectionByAgentId((current) => ({ ...current, [agentId]: section })),
    startFileEditing,
    cancelFileEditing,
    openPromptDetail: (agentId: string) => setSelectedDetailByAgentId((current) => ({ ...current, [agentId]: { kind: 'prompt' } })),
    selectIdentityFile: (agentId: string, file: string) =>
      setSelectedDetailByAgentId((current) => ({
        ...current,
        [agentId]: { kind: 'file', path: file },
      })),
    updatePrompt: (agentId: string, value: string) => updateAgentDraft(agentId, (current) => ({ ...current, systemPrompt: value })),
    replaceAgentDraft,
    updateActiveFileDraft,
    toggleSkill: (agentId: string, skill: string, selected: boolean) =>
      updateAgentDraft(agentId, (current) => ({
        ...current,
        loadedSkills: selected
          ? current.loadedSkills.filter((entry) => entry !== skill)
          : [...current.loadedSkills, skill].sort((left, right) => left.localeCompare(right)),
      })),
    toggleCapability: (agentId: string, kind: 'skill' | 'tool' | 'plugin', name: string, selected: boolean) =>
      updateAgentDraft(agentId, (current) => {
        const field = kind === 'skill' ? 'loadedSkills' : kind === 'tool' ? 'loadedTools' : 'loadedPlugins';
        return {
          ...current,
          [field]: selected
            ? current[field].filter((entry) => entry !== name)
            : [...current[field], name].sort((left, right) => left.localeCompare(right)),
        };
      }),
    renameCapability: (agentId: string, kind: 'skill' | 'tool' | 'plugin', previousName: string, nextName: string) =>
      updateAgentDraft(agentId, (current) => {
        const field = kind === 'skill' ? 'loadedSkills' : kind === 'tool' ? 'loadedTools' : 'loadedPlugins';
        const normalized = nextName.trim();
        if (!normalized) return current;
        return {
          ...current,
          [field]: Array.from(new Set(current[field].map((entry) => entry === previousName ? normalized : entry)))
            .sort((left, right) => left.localeCompare(right)),
        };
      }),
  };
}
