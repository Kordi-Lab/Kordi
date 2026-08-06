import { useCallback, type Dispatch, type SetStateAction } from 'react';

import { cloudAgentDefinitionToAgent } from '@/features/cloud/cloudAgents';
import type {
  CreateCloudAgentInput,
  UpdateCloudAgentInput,
} from '@/features/cloud/cloudAgentsClient';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import type { Agent } from '@/kordi-app/types';

type UseKordiCloudAgentActionsArgs = {
  archiveCloudAgentDefinition:
    UseCloudCollaborationStateResult['archiveCloudAgentDefinition'];
  createCloudAgentDefinition:
    UseCloudCollaborationStateResult['createCloudAgentDefinition'];
  refreshCloudAgents: UseCloudCollaborationStateResult['refreshCloudAgents'];
  setActiveAgentId: Dispatch<SetStateAction<string>>;
  updateCloudAgentDefinition:
    UseCloudCollaborationStateResult['updateCloudAgentDefinition'];
};

export function useKordiCloudAgentActions({
  archiveCloudAgentDefinition,
  createCloudAgentDefinition,
  refreshCloudAgents,
  setActiveAgentId,
  updateCloudAgentDefinition,
}: UseKordiCloudAgentActionsArgs) {
  const createCloudAgent = useCallback(
    async (input: CreateCloudAgentInput) => {
      const definition = await createCloudAgentDefinition(input);
      await refreshCloudAgents().catch(() => undefined);
      const agent = cloudAgentDefinitionToAgent(definition);
      setActiveAgentId(agent.id);
      return agent;
    },
    [createCloudAgentDefinition, refreshCloudAgents, setActiveAgentId],
  );

  const updateCloudAgent = useCallback(
    async (agent: Agent, input: UpdateCloudAgentInput) => {
      if (!agent.cloudAgentId) {
        throw new Error('This agent has not been synchronized yet.');
      }
      const definition = await updateCloudAgentDefinition(
        agent.cloudAgentId,
        input,
      );
      await refreshCloudAgents().catch(() => undefined);
      const nextAgent = cloudAgentDefinitionToAgent(definition);
      setActiveAgentId(nextAgent.id);
      return nextAgent;
    },
    [refreshCloudAgents, setActiveAgentId, updateCloudAgentDefinition],
  );

  const archiveCloudAgent = useCallback(
    async (agent: Agent) => {
      if (!agent.cloudAgentId) {
        throw new Error('This agent cannot be deleted here.');
      }
      await archiveCloudAgentDefinition(agent.cloudAgentId);
      await refreshCloudAgents().catch(() => undefined);
      setActiveAgentId((current) => (
        current === agent.id ? 'desktop:local-agent' : current
      ));
    },
    [archiveCloudAgentDefinition, refreshCloudAgents, setActiveAgentId],
  );

  return {
    archiveCloudAgent,
    createCloudAgent,
    updateCloudAgent,
  };
}
