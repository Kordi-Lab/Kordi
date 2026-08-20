import type { Agent, ParticipantSpaceKind } from '@/kordi-app/types';

export function usesDefaultLocalAgentSession(
  agent: Pick<Agent, 'id' | 'isOwned' | 'cloudAgentId' | 'isCollaborationDefault'>,
) {
  return Boolean(agent.isOwned && !agent.cloudAgentId && (
    agent.id === 'desktop:local-agent' || agent.isCollaborationDefault
  ));
}

export function agentSessionKind(agent: Agent) {
  return usesDefaultLocalAgentSession(agent) ? 'self-agent' as const : 'direct-agent' as const;
}

export function agentSessionParticipantSpaceKind(agent: Agent): ParticipantSpaceKind {
  return usesDefaultLocalAgentSession(agent) ? 'self' : 'direct-agent';
}
