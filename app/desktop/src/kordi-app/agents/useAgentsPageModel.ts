import { useEffect, useMemo, useState } from 'react';
import { readDesktopWorkspaceTextFile, writeDesktopWorkspaceTextFile } from '@/lib/desktop';
import type { Agent } from '../types';
import {
  AGENT_CONFIG_STORAGE_KEY,
  buildAgentDraft,
  buildUnavailableFilePreview,
  buildPersistedAgentConfig,
  getAgentConfigPath,
  isEditableWorkspaceTextFile,
  isRepoFilePath,
  parsePersistedAgentConfig,
  readStoredAgentDrafts,
  type AgentConfigDraft,
  type AgentSaveFeedback,
  type PersistedAgentConfig,
} from './model';

const EMPTY_FILE_PREVIEW = { status: 'idle' as const, text: '' };

type AgentDetailTarget =
  | { kind: 'prompt' }
  | { kind: 'file'; path: string };

export function useAgentsPageModel(agents: Agent[], activeAgent?: Agent) {
  const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentConfigDraft>>(() => readStoredAgentDrafts());
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
            },
          ];
        }),
      ) as Record<string, AgentConfigDraft>,
    [agentDrafts, agents, persistedAgentConfigs],
  );

  const activeAgentConfig = activeAgent ? agentConfigs[activeAgent.id] ?? buildAgentDraft(activeAgent) : null;
  const activePersistedConfig = activeAgent ? persistedAgentConfigs[activeAgent.id] ?? buildPersistedAgentConfig(activeAgent) : null;
  const availableSkills = useMemo(
    () =>
      Array.from(
        new Set([
          ...(activePersistedConfig?.loadedSkills ?? []),
          ...(activeAgentConfig?.loadedSkills ?? []),
        ]),
      ).sort((left, right) => left.localeCompare(right)),
    [activeAgentConfig?.loadedSkills, activePersistedConfig?.loadedSkills],
  );
  const activeDetail = activeAgent ? selectedDetailByAgentId[activeAgent.id] ?? { kind: 'prompt' as const } : null;
  const activeIdentityFile = activeDetail?.kind === 'file' ? activeDetail.path : null;
  const activeConfigPath = activeAgent ? getAgentConfigPath(activeAgent) : null;
  const activeSaveFeedback = activeAgent
    ? saveFeedbackByAgentId[activeAgent.id] ?? {
        tone: 'idle' as const,
        text: activeConfigPath
          ? `Loaded from ${activeConfigPath}`
          : activeAgent.systemPrompt.trim().length > 0
            ? 'Loaded from exact current runtime'
            : 'No real prompt/config exposed by this bridge agent',
      }
    : null;
  const activeEditingSection = activeAgent ? editingSectionByAgentId[activeAgent.id] ?? null : null;
  const activeFileCanEdit = Boolean(activeIdentityFile && canUseNativeFileAccess && isEditableWorkspaceTextFile(activeIdentityFile));
  const activeFileIsEditing = Boolean(activeIdentityFile && editingFilePath === activeIdentityFile && activeFileCanEdit);
  const activeFileDraft = activeIdentityFile ? fileDraftsByPath[activeIdentityFile] ?? activeFilePreview.text : '';
  const activeFileSaveFeedback = activeIdentityFile
    ? fileSaveFeedbackByPath[activeIdentityFile] ?? {
        tone: 'idle' as const,
        text: activeFileCanEdit ? 'Repo-relative file ready to preview or edit' : 'Read-only preview',
      }
    : null;

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

  const updateAgentDraft = (agentId: string, apply: (current: AgentConfigDraft) => AgentConfigDraft) => {
    setAgentDrafts((current) => {
      const fallbackAgent = agents.find((agent) => agent.id === agentId) ?? activeAgent ?? agents[0];
      if (!fallbackAgent) {
        return current;
      }
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
    const nextRaw = `${JSON.stringify(nextPersisted, null, 2)}\n`;

    try {
      await writeDesktopWorkspaceTextFile(configPath, nextRaw);
      setPersistedAgentConfigs((current) => ({ ...current, [agent.id]: nextPersisted }));
      setEditingSectionByAgentId((current) => ({ ...current, [agent.id]: null }));
      setSaveFeedbackByAgentId((current) => ({
        ...current,
        [agent.id]: { tone: 'success', text: `${section === 'prompt' ? 'System prompt' : 'Skills'} saved to ${configPath}` },
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
    resetAgentDraft,
    saveAgentConfig,
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
    updateActiveFileDraft,
    toggleSkill: (agentId: string, skill: string, selected: boolean) =>
      updateAgentDraft(agentId, (current) => ({
        ...current,
        loadedSkills: selected
          ? current.loadedSkills.filter((entry) => entry !== skill)
          : [...current.loadedSkills, skill].sort((left, right) => left.localeCompare(right)),
      })),
  };
}
