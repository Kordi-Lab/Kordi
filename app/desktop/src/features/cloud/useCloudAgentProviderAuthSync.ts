import { useEffect, useRef } from 'react';

import type { DesktopAuthState } from '@/kordi-app/types';
import type { CloudAccount, CloudAuthClient } from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import type { UpdateCloudAgentInput } from './cloudAgentsClient';
import { retargetCloudAgentModelRoutingForAuthState } from './providerAuthSnapshot';
import { useCloudProviderAuthSnapshotSync } from './useCloudProviderAuthSnapshotSync';

export function useCloudAgentProviderAuthSync({
  account,
  client,
  authState,
  agentDefinitionsById,
  initialMessagesSettled,
  updateDefinition,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  authState?: DesktopAuthState | null;
  agentDefinitionsById: Record<string, CloudAgentDefinition>;
  initialMessagesSettled: boolean;
  updateDefinition: (
    agentId: string,
    input: UpdateCloudAgentInput,
  ) => Promise<CloudAgentDefinition>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const { reconciledAuthState } = useCloudProviderAuthSnapshotSync({
    account,
    client,
    authState,
    initialMessagesSettled,
    reportWarning,
  });
  const repairsInFlightRef = useRef(new Set<string>());

  useEffect(() => {
    if (!account || !reconciledAuthState) return;
    for (const definition of Object.values(agentDefinitionsById)) {
      if (
        definition.ownerAccountId !== account.accountId
        || definition.status !== 'active'
        || repairsInFlightRef.current.has(definition.agentId)
      ) continue;
      const modelRouting = retargetCloudAgentModelRoutingForAuthState(
        definition.modelRouting,
        reconciledAuthState,
      );
      if (!modelRouting) continue;
      repairsInFlightRef.current.add(definition.agentId);
      void updateDefinition(definition.agentId, { modelRouting })
        .catch((error) => {
          reportWarning(
            '[cloud-provider-auth-sync] agent route repair failed',
            error,
          );
        })
        .finally(() => {
          repairsInFlightRef.current.delete(definition.agentId);
        });
    }
  }, [
    account,
    agentDefinitionsById,
    reconciledAuthState,
    reportWarning,
    updateDefinition,
  ]);
}
