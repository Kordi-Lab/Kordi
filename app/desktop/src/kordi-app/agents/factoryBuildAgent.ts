import { useState } from 'react';

import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import type { Agent } from '../types';
import type { FactoryBuildRoute } from './model';

export type ResolvedFactoryBuildAgent = { artifactId: string; agent: Agent } | null;

/**
 * The agent a Build route edits. While the agent list is rebuilt (a publish refreshes it) the
 * default agent can briefly vanish or change id: a default-agent route then follows the list's
 * default agent, and any route keeps its last resolved agent instead of dropping to none.
 */
export function resolveFactoryBuildAgent(
  route: FactoryBuildRoute | null | undefined,
  agents: readonly Agent[],
  last: ResolvedFactoryBuildAgent,
): Agent | undefined {
  if (route?.artifactKind !== 'agent' || !route.artifactId) return undefined;
  const exact = agents.find((agent) => agent.id === route.artifactId);
  if (exact) return exact;
  const defaultAgent = route.defaultAgent ? agents.find(usesDefaultLocalAgentSession) : undefined;
  if (defaultAgent) return defaultAgent;
  return last?.artifactId === route.artifactId ? last.agent : undefined;
}

export function useFactoryBuildAgent(route: FactoryBuildRoute | null | undefined, agents: readonly Agent[]) {
  const [last, setLast] = useState<ResolvedFactoryBuildAgent>(null);
  const agent = resolveFactoryBuildAgent(route, agents, last);
  const artifactId = route?.artifactId;
  // Remember the latest match for this route (React's "adjust state while rendering" pattern).
  if (agent && artifactId && (last?.agent !== agent || last.artifactId !== artifactId)) {
    setLast({ artifactId, agent });
  }
  return agent;
}
