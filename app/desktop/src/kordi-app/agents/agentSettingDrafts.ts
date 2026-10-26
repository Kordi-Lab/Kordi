import type { Agent } from '../types';
import { buildAgentStudioDraft, type AgentSettingKey, type AgentStudioConfigDraft, type PersistedAgentConfig } from './model';

// Cooperative and Proactive live on the server and can change on another
// device. A draft holds them only while they are edited here; everywhere else
// the server value is used, so a published or stale draft never sends an old
// value back.

/** The draft without its settings, as stored after a publish or a revert. */
export function withoutAgentSettings<T extends Partial<AgentStudioConfigDraft>>(draft: T) {
  const { proactive: _cooperative, personalProactive: _proactive, editedSettings: _edited, ...rest } = draft;
  return rest;
}

/** A published config whose settings are the agent's current server values. */
export function withServerAgentSettings(persisted: PersistedAgentConfig, agent: Agent): PersistedAgentConfig {
  const server = buildAgentStudioDraft(agent);
  return {
    ...withoutAgentSettings(persisted),
    editHistory: persisted.editHistory,
    ...(server.proactive ? { proactive: server.proactive } : {}),
    ...(server.personalProactive !== undefined ? { personalProactive: server.personalProactive } : {}),
  };
}

/** Only the settings a stored draft changed here. */
export function editedAgentSettings(stored: Partial<AgentStudioConfigDraft> | undefined): Partial<AgentStudioConfigDraft> {
  const edited = stored?.editedSettings ?? [];
  return {
    ...(edited.includes('proactive') && stored?.proactive ? { proactive: stored.proactive } : {}),
    ...(edited.includes('personalProactive') && stored?.personalProactive !== undefined ? { personalProactive: stored.personalProactive } : {}),
    ...(edited.length ? { editedSettings: edited } : {}),
  };
}

/** The draft with one setting changed here. */
export function withEditedAgentSetting(draft: AgentStudioConfigDraft, key: AgentSettingKey, value: Partial<AgentStudioConfigDraft>): AgentStudioConfigDraft {
  return { ...draft, ...value, editedSettings: [...new Set([...(draft.editedSettings ?? []), key])] };
}
