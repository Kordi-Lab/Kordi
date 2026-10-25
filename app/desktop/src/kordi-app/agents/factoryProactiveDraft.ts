import { useCallback, useState } from 'react';
import type { CloudAgentProactive } from '@/features/cloud/cloudAgentsClient';
import type { Agent } from '../types';
import type { AgentProactiveControl } from './AgentStudioBlueprintView';
import type { AgentStudioConfigDraft } from './model';

/** New agents keep their Proactive choice per Factory draft until the agent is created. */
export const CREATION_PROACTIVE_STORAGE_KEY = 'kordi.agent-creation-proactive.v1';

function readStored(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CREATION_PROACTIVE_STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return {};
  }
}

export function useCreationProactiveDraft(draftId: string | null) {
  const [byDraftId, setByDraftId] = useState<Record<string, boolean>>(() => (typeof window === 'undefined' ? {} : readStored()));
  const setEnabled = useCallback((enabled: boolean) => {
    if (!draftId) return;
    setByDraftId((current) => {
      const next = { ...current, [draftId]: enabled };
      try { window.localStorage.setItem(CREATION_PROACTIVE_STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep the in-memory choice. */ }
      return next;
    });
  }, [draftId]);
  const enabled = Boolean(draftId && byDraftId[draftId]);
  return { enabled, setEnabled, input: (enabled ? { enabled: true } : undefined) as CloudAgentProactive | undefined };
}

/** The Blueprint's Proactive row for the agent being built: cloud agents and new agents only. */
export function factoryProactiveControl({ creating, creation, agent, config, setProactiveDraft }: {
  creating: boolean;
  creation: ReturnType<typeof useCreationProactiveDraft>;
  agent?: Agent;
  config: AgentStudioConfigDraft | null;
  setProactiveDraft: (agentId: string, enabled: boolean) => void;
}): AgentProactiveControl | undefined {
  if (creating) return { enabled: creation.enabled, onChange: creation.setEnabled };
  if (!agent?.cloudAgentId) return undefined;
  return { enabled: config?.proactive?.enabled ?? agent.cloudAgentProactive?.enabled === true, onChange: (enabled) => setProactiveDraft(agent.id, enabled) };
}
