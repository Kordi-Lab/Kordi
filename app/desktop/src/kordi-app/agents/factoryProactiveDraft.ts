import { useCallback, useEffect, useState } from 'react';
import type { CloudAgentPersonalAgent, CloudAgentProactive } from '@/features/cloud/cloudAgentsClient';
import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import { defaultAgentProactiveId, getProactiveSetting, setProactiveSetting } from '@/features/cloud/proactiveClient';
import { loadSession } from '@/features/cloud/session';
import { getPersonalAgentSetting, setPersonalAgentSetting } from '@/features/personalAgent/personalAgentClient';
import type { Agent } from '../types';
import type { AgentProactiveControl } from './AgentStudioBlueprintView';
import { cloudAgentProactiveLabel, type AgentStudioConfigDraft } from './model';

// The Blueprint's two agent settings. Cooperative keeps its pre-#2091
// internal name `proactive` (draft field, change key, API alias); Proactive
// is `personalProactive` here and `personalAgent.proactive` on the server.

/** New agents keep their Cooperative choice per Factory draft until the agent is created. */
export const CREATION_PROACTIVE_STORAGE_KEY = 'kordi.agent-creation-proactive.v1';
/** New agents keep their Proactive choice per Factory draft until the agent is created. */
export const CREATION_PERSONAL_PROACTIVE_STORAGE_KEY = 'kordi.agent-creation-personal-proactive.v1';

/** Change keys published through the agent settings routes, never written to a local config file. */
export const AGENT_SETTING_CHANGE_KEYS: ReadonlySet<string> = new Set(['proactive', 'personalProactive']);

function readStored(storageKey: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return {};
  }
}

function useCreationFlag(storageKey: string, draftId: string | null) {
  const [byDraftId, setByDraftId] = useState<Record<string, boolean>>(() => (typeof window === 'undefined' ? {} : readStored(storageKey)));
  const setEnabled = useCallback((enabled: boolean) => {
    if (!draftId) return;
    setByDraftId((current) => {
      const next = { ...current, [draftId]: enabled };
      try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the in-memory choice. */ }
      return next;
    });
  }, [draftId, storageKey]);
  return { enabled: Boolean(draftId && byDraftId[draftId]), setEnabled };
}

export function useCreationProactiveDraft(draftId: string | null) {
  const cooperative = useCreationFlag(CREATION_PROACTIVE_STORAGE_KEY, draftId);
  const personal = useCreationFlag(CREATION_PERSONAL_PROACTIVE_STORAGE_KEY, draftId);
  return {
    enabled: cooperative.enabled,
    setEnabled: cooperative.setEnabled,
    input: (cooperative.enabled ? { enabled: true } : undefined) as CloudAgentProactive | undefined,
    personalEnabled: personal.enabled,
    setPersonalEnabled: personal.setEnabled,
    personalInput: (personal.enabled ? { proactive: true } : undefined) as CloudAgentPersonalAgent | undefined,
  };
}

type CreationDraft = Pick<ReturnType<typeof useCreationProactiveDraft>, 'enabled' | 'setEnabled'>
  & Partial<Pick<ReturnType<typeof useCreationProactiveDraft>, 'personalEnabled' | 'setPersonalEnabled'>>;

export type DefaultAgentProactive = ReturnType<typeof useDefaultAgentProactive>;

/**
 * The owner's default agent keeps both settings on the server under
 * `cloud-agent:<accountId>`. They are fetched once per signed-in account;
 * `published` (Cooperative) and `personalPublished` (Proactive) stay null
 * while signed out, before the fetch lands, or when their route fails.
 */
export function useDefaultAgentProactive(agent: Agent | undefined, cloudAccountId?: string | null) {
  const isDefault = Boolean(agent && usesDefaultLocalAgentSession(agent));
  const [state, setState] = useState<{ agentId: string; enabled: boolean | null; personal: boolean | null } | null>(null);
  useEffect(() => {
    if (!isDefault) return;
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token || !session.accountId) return null;
      const agentId = defaultAgentProactiveId(session.accountId);
      const [cooperative, personal] = await Promise.allSettled([
        getProactiveSetting(session.token, agentId),
        getPersonalAgentSetting(session.token, agentId),
      ]);
      return {
        agentId,
        enabled: cooperative.status === 'fulfilled' ? cooperative.value.enabled : null,
        personal: personal.status === 'fulfilled' ? personal.value.proactive : null,
      };
    })().then((next) => { if (!cancelled) setState(next); }, () => { if (!cancelled) setState(null); });
    return () => { cancelled = true; };
  }, [cloudAccountId, isDefault]);
  const publish = useCallback(async (enabled: boolean) => {
    const session = await loadSession();
    if (!session?.token || !session.accountId) throw new Error('Sign in to change Cooperative.');
    const agentId = defaultAgentProactiveId(session.accountId);
    const saved = await setProactiveSetting(session.token, agentId, enabled);
    setState((current) => ({ agentId, enabled: saved.enabled, personal: current?.agentId === agentId ? current.personal : null }));
  }, []);
  const publishPersonal = useCallback(async (proactive: boolean) => {
    const session = await loadSession();
    if (!session?.token || !session.accountId) throw new Error('Sign in to change Proactive.');
    const agentId = defaultAgentProactiveId(session.accountId);
    const saved = await setPersonalAgentSetting(session.token, agentId, proactive);
    setState((current) => ({ agentId, enabled: current?.agentId === agentId ? current.enabled : null, personal: saved.proactive }));
  }, []);
  const current = isDefault ? state : null;
  return {
    agentId: current?.agentId ?? null,
    published: current ? current.enabled : null,
    personalPublished: current ? current.personal : null,
    publish,
    publishPersonal,
  };
}

type DraftChange = { key: string; label: string; detail: string };

/** The default agent's change list: its Cooperative entry compares the draft with the server value, never the local config. */
export function withDefaultAgentProactiveChange<T extends DraftChange>(changes: T[], config: AgentStudioConfigDraft | null, published: boolean | null): T[] {
  const rest = changes.filter((change) => change.key !== 'proactive');
  if (published === null || !config?.proactive || config.proactive.enabled === published) return rest;
  return [...rest, { key: 'proactive', label: 'Cooperative updated', detail: cloudAgentProactiveLabel(config.proactive.enabled) } as T];
}

/** The default agent's Proactive entry, against the server value like Cooperative. */
export function withDefaultAgentPersonalProactiveChange<T extends DraftChange>(changes: T[], config: AgentStudioConfigDraft | null, published: boolean | null): T[] {
  const rest = changes.filter((change) => change.key !== 'personalProactive');
  if (published === null || config?.personalProactive === undefined || config.personalProactive === published) return rest;
  return [...rest, { key: 'personalProactive', label: 'Proactive updated', detail: cloudAgentProactiveLabel(config.personalProactive) } as T];
}

/** Both default agent settings entries of the change list. */
export function withDefaultAgentSettingChanges<T extends DraftChange>(
  changes: T[],
  config: AgentStudioConfigDraft | null,
  defaultAgent: Pick<DefaultAgentProactive, 'published' | 'personalPublished'>,
): T[] {
  return withDefaultAgentPersonalProactiveChange(withDefaultAgentProactiveChange(changes, config, defaultAgent.published), config, defaultAgent.personalPublished);
}

/** The settings part of a Factory agent's update body: only the settings the draft changed. */
export function cloudAgentSettingsUpdate(changes: readonly DraftChange[], config: AgentStudioConfigDraft) {
  const changed = (key: string) => changes.some((change) => change.key === key);
  return {
    ...(changed('proactive') && config.proactive ? { proactive: config.proactive } : {}),
    ...(changed('personalProactive') && config.personalProactive !== undefined ? { personalAgent: { proactive: config.personalProactive } } : {}),
  };
}

/** Publishes the default agent's changed settings through their own routes. */
export async function publishDefaultAgentSettings(
  defaultAgent: Pick<DefaultAgentProactive, 'publish' | 'publishPersonal'>,
  changes: readonly DraftChange[],
  config: AgentStudioConfigDraft,
) {
  const update = cloudAgentSettingsUpdate(changes, config);
  if (update.proactive) await defaultAgent.publish(update.proactive.enabled);
  if (update.personalAgent) await defaultAgent.publishPersonal(update.personalAgent.proactive);
}

/** The Blueprint's Cooperative and Proactive rows for the agent being built: cloud agents, the signed-in default agent, and new agents. */
export function factoryProactiveControl({ creating, creation, agent, config, setProactiveDraft, setPersonalProactiveDraft, defaultAgent }: {
  creating: boolean;
  creation: CreationDraft;
  agent?: Agent;
  config: AgentStudioConfigDraft | null;
  setProactiveDraft: (agentId: string, enabled: boolean) => void;
  setPersonalProactiveDraft?: (agentId: string, enabled: boolean) => void;
  defaultAgent?: Pick<DefaultAgentProactive, 'agentId' | 'published'> & Partial<Pick<DefaultAgentProactive, 'personalPublished'>>;
}): AgentProactiveControl | undefined {
  const personalRow = (enabled: boolean) => (agent && setPersonalProactiveDraft
    ? { personal: { enabled: config?.personalProactive ?? enabled, onChange: (next: boolean) => setPersonalProactiveDraft(agent.id, next) } }
    : {});
  if (creating) {
    return {
      enabled: creation.enabled,
      onChange: creation.setEnabled,
      ...(creation.setPersonalEnabled ? { personal: { enabled: creation.personalEnabled === true, onChange: creation.setPersonalEnabled } } : {}),
    };
  }
  if (agent && !agent.cloudAgentId && defaultAgent?.agentId && defaultAgent.published !== null && usesDefaultLocalAgentSession(agent)) {
    const published = defaultAgent.published;
    const personalPublished = defaultAgent.personalPublished ?? null;
    return {
      enabled: config?.proactive?.enabled ?? published,
      onChange: (enabled) => setProactiveDraft(agent.id, enabled),
      activity: { agentId: defaultAgent.agentId, enabled: published },
      ...(personalPublished === null ? {} : personalRow(personalPublished)),
    };
  }
  if (!agent?.cloudAgentId) return undefined;
  return {
    enabled: config?.proactive?.enabled ?? agent.cloudAgentProactive?.enabled === true,
    onChange: (enabled) => setProactiveDraft(agent.id, enabled),
    ...personalRow(agent.cloudAgentPersonalAgent?.proactive === true),
  };
}
