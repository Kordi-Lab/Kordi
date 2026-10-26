import { useEffect, useSyncExternalStore } from 'react';
import type { Agent } from '@/kordi-app/types';

// "Agent settings" in a personal session's menu opens that agent's Blueprint.
// The sidebar records the request; the Agents page opens the Blueprint once it
// has the agent, on mount or while it is already open.

let pending: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Asks the Agents page to open the Blueprint of the local agent `localAgentId`. */
export function requestAgentBlueprint(localAgentId: string) {
  pending = localAgentId.trim() || null;
  emit();
}

export function pendingAgentBlueprintRequest() {
  return pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Opens the requested Blueprint with `open` once `agents` holds the agent, then clears the request. */
export function useAgentBlueprintRequest(agents: readonly Agent[], open: (agent: Agent) => void) {
  const requested = useSyncExternalStore(subscribe, pendingAgentBlueprintRequest, pendingAgentBlueprintRequest);
  useEffect(() => {
    if (!requested || pending !== requested) return;
    const agent = agents.find((candidate) => candidate.id === requested);
    if (!agent) return;
    pending = null;
    emit();
    open(agent);
  }, [agents, open, requested]);
}
