import { useState, type Dispatch, type SetStateAction } from 'react';

import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import type { CanonicalAvatarMutation } from '@/features/cloud/canonicalAvatar';
import type { Agent } from '../types';
import { useLocalAgentAvatar } from '../components/useLocalAgentAvatar';
import type { AgentSaveFeedback, AgentsPageProps } from './model';
import { randomFactoryCreationAvatar, type useFactoryCreationAvatar } from './useFactoryCreationAvatar';

type FactoryAgentAvatarActionsOptions = {
  creating: boolean;
  agent?: Agent;
  factoryAvatar: ReturnType<typeof useFactoryCreationAvatar>;
  onUpdateCloudAgent?: AgentsPageProps['onUpdateCloudAgent'];
  onUpdateLocalAgentAvatar?: AgentsPageProps['onUpdateLocalAgentAvatar'];
  setPublishFeedback: Dispatch<SetStateAction<AgentSaveFeedback | null>>;
};

/**
 * The Blueprint Avatar row. A new agent stages its avatar until it is published; an existing
 * agent saves each pick or upload at once, without the publish model test.
 */
export function useFactoryAgentAvatarActions({
  creating,
  agent,
  factoryAvatar,
  onUpdateCloudAgent,
  onUpdateLocalAgentAvatar,
  setPublishFeedback,
}: FactoryAgentAvatarActionsOptions) {
  // Re-render when the user's own agent avatar snapshot changes after a save.
  useLocalAgentAvatar();
  const [pending, setPending] = useState<{ agentId: string; imageUrl: string } | null>(null);

  const apply = (mutation: CanonicalAvatarMutation, previewUrl: string) => {
    if (creating || !agent) return false;
    let save: unknown;
    if (agent.cloudAgentId && onUpdateCloudAgent) {
      save = onUpdateCloudAgent(agent, { avatarMutation: { ...mutation, expectedVersion: agent.cloudAgentAvatarVersion } });
    } else if (!agent.cloudAgentId && usesDefaultLocalAgentSession(agent) && onUpdateLocalAgentAvatar) {
      save = onUpdateLocalAgentAvatar(mutation);
    } else {
      return false;
    }
    setPending({ agentId: agent.id, imageUrl: previewUrl });
    void Promise.resolve(save)
      .catch((error: unknown) => {
        setPublishFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'Kordi could not change the avatar.' });
      })
      .finally(() => setPending(null));
    return true;
  };

  return {
    imageUrl: pending && pending.agentId === agent?.id ? pending.imageUrl : factoryAvatar.imageUrl,
    upload: (uploadedAsset: string) => {
      if (!apply({ action: 'upload', uploadedAsset }, uploadedAsset)) factoryAvatar.upload(uploadedAsset);
    },
    randomize: (seed?: string) => {
      const avatar = randomFactoryCreationAvatar(seed);
      if (!avatar?.mutation) return;
      if (!apply(avatar.mutation, avatar.imageUrl)) factoryAvatar.randomize(avatar.mutation.seed);
    },
  };
}
