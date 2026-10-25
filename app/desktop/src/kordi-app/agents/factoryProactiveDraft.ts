import { useCallback, useEffect, useState } from 'react';
import type { CloudAgentProactive } from '@/features/cloud/cloudAgentsClient';
import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import { defaultAgentProactiveId, getProactiveSetting, setProactiveSetting } from '@/features/cloud/proactiveClient';
import { loadSession } from '@/features/cloud/session';
import type { Agent } from '../types';
import type { AgentProactiveControl } from './AgentStudioBlueprintView';
import { cloudAgentProactiveLabel, type AgentStudioConfigDraft } from './model';

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

export type DefaultAgentProactive = ReturnType<typeof useDefaultAgentProactive>;

/**
 * The owner's default agent keeps its Proactive setting on the server under
 * `cloud-agent:<accountId>`. The value is fetched once per signed-in account;
 * `published` stays null while signed out or before the fetch lands.
 */
export function useDefaultAgentProactive(agent: Agent | undefined, cloudAccountId?: string | null) {
  const isDefault = Boolean(agent && usesDefaultLocalAgentSession(agent));
  const [state, setState] = useState<{ agentId: string; enabled: boolean } | null>(null);
  useEffect(() => {
    if (!isDefault) return;
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token || !session.accountId) return null;
      const agentId = defaultAgentProactiveId(session.accountId);
      return { agentId, enabled: (await getProactiveSetting(session.token, agentId)).enabled };
    })().then((next) => { if (!cancelled) setState(next); }, () => { if (!cancelled) setState(null); });
    return () => { cancelled = true; };
  }, [cloudAccountId, isDefault]);
  const publish = useCallback(async (enabled: boolean) => {
    const session = await loadSession();
    if (!session?.token || !session.accountId) throw new Error('Sign in to change Proactive.');
    const agentId = defaultAgentProactiveId(session.accountId);
    const saved = await setProactiveSetting(session.token, agentId, enabled);
    setState({ agentId, enabled: saved.enabled });
  }, []);
  const current = isDefault ? state : null;
  return { agentId: current?.agentId ?? null, published: current ? current.enabled : null, publish };
}

type DraftChange = { key: string; label: string; detail: string };

/** The default agent's change list: its Proactive entry compares the draft with the server value, never the local config. */
export function withDefaultAgentProactiveChange<T extends DraftChange>(changes: T[], config: AgentStudioConfigDraft | null, published: boolean | null): T[] {
  const rest = changes.filter((change) => change.key !== 'proactive');
  if (published === null || !config?.proactive || config.proactive.enabled === published) return rest;
  return [...rest, { key: 'proactive', label: 'Proactive updated', detail: cloudAgentProactiveLabel(config.proactive.enabled) } as T];
}

/** The Blueprint's Proactive row for the agent being built: cloud agents, the signed-in default agent, and new agents. */
export function factoryProactiveControl({ creating, creation, agent, config, setProactiveDraft, defaultAgent }: {
  creating: boolean;
  creation: ReturnType<typeof useCreationProactiveDraft>;
  agent?: Agent;
  config: AgentStudioConfigDraft | null;
  setProactiveDraft: (agentId: string, enabled: boolean) => void;
  defaultAgent?: Pick<DefaultAgentProactive, 'agentId' | 'published'>;
}): AgentProactiveControl | undefined {
  if (creating) return { enabled: creation.enabled, onChange: creation.setEnabled };
  if (agent && !agent.cloudAgentId && defaultAgent?.agentId && defaultAgent.published !== null && usesDefaultLocalAgentSession(agent)) {
    const published = defaultAgent.published;
    return {
      enabled: config?.proactive?.enabled ?? published,
      onChange: (enabled) => setProactiveDraft(agent.id, enabled),
      activity: { agentId: defaultAgent.agentId, enabled: published },
    };
  }
  if (!agent?.cloudAgentId) return undefined;
  return { enabled: config?.proactive?.enabled ?? agent.cloudAgentProactive?.enabled === true, onChange: (enabled) => setProactiveDraft(agent.id, enabled) };
}
