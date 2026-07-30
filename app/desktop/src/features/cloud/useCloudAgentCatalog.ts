import {
  useCallback,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  CloudAccount,
} from './authClient';
import type {
  CloudAgentDefinition,
  SharedCloudAgentSummary,
} from './cloudAgents';
import type {
  CloudAgentsClient,
  CreateCloudAgentInput,
  UpdateCloudAgentInput,
} from './cloudAgentsClient';
import type {
  CloudSyncCoordinator,
} from './cloudSyncCoordinator';
import {
  loadSession,
} from './session';

type CloudAgentCatalogStores = {
  setDefinitionsById: Dispatch<
    SetStateAction<Record<string, CloudAgentDefinition>>
  >;
  sharedByOwner: Record<string, SharedCloudAgentSummary[]>;
  setSharedByOwner: Dispatch<
    SetStateAction<Record<string, SharedCloudAgentSummary[]>>
  >;
};

function recordEqual<T>(current: T, next: T) {
  return JSON.stringify(current) === JSON.stringify(next);
}

export function useCloudAgentCatalog({
  account,
  client,
  syncCoordinator,
  cancelledRef,
  stores,
}: {
  account: CloudAccount | null;
  client: CloudAgentsClient;
  syncCoordinator: CloudSyncCoordinator;
  cancelledRef: MutableRefObject<boolean>;
  stores: CloudAgentCatalogStores;
}) {
  const {
    setDefinitionsById,
    sharedByOwner,
    setSharedByOwner,
  } = stores;

  const refreshDefinitions = useCallback(async (
    generation?: number,
  ) => {
    if (!account) {
      setDefinitionsById({});
      return;
    }
    const session = await loadSession();
    if (!session?.token) return;
    const agents = await client.listCloudAgents(session.token);
    if (
      cancelledRef.current
      || (
        generation !== undefined
        && !syncCoordinator.isCurrentGeneration(generation)
      )
    ) return;
    const next = Object.fromEntries(
      agents.map((agent) => [agent.agentId, agent]),
    );
    setDefinitionsById((current) =>
      recordEqual(current, next) ? current : next
    );
  }, [
    account,
    cancelledRef,
    client,
    setDefinitionsById,
    syncCoordinator,
  ]);

  const sharedAgents = useMemo(
    () => Object.values(sharedByOwner).flat(),
    [sharedByOwner],
  );

  const refreshShared = useCallback(async (
    ownerAccountIds: string[],
  ) => {
    const owners = [
      ...new Set(
        ownerAccountIds
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!account || owners.length === 0) {
      setSharedByOwner((current) =>
        Object.keys(current).length === 0 ? current : {}
      );
      return [];
    }
    const session = await loadSession();
    if (!session?.token) return [];
    const agents = await client.listSharedCloudAgents(
      session.token,
      owners,
    );
    const next: Record<string, SharedCloudAgentSummary[]> = {};
    for (const agent of agents) {
      next[agent.ownerAccountId] = [
        ...(next[agent.ownerAccountId] ?? []),
        agent,
      ];
    }
    setSharedByOwner((current) =>
      recordEqual(current, next) ? current : next
    );
    return agents;
  }, [account, client, setSharedByOwner]);

  const createDefinition = useCallback(async (
    input: CreateCloudAgentInput,
  ) => {
    const session = await loadSession();
    if (!session?.token) {
      throw new Error('Sign in to Cloud before creating an agent.');
    }
    const agent = await client.createCloudAgent(session.token, input);
    setDefinitionsById((current) => ({
      ...current,
      [agent.agentId]: agent,
    }));
    return agent;
  }, [client, setDefinitionsById]);

  const updateDefinition = useCallback(async (
    agentId: string,
    input: UpdateCloudAgentInput,
  ) => {
    const session = await loadSession();
    if (!session?.token) {
      throw new Error('Sign in to Cloud before updating an agent.');
    }
    const agent = await client.updateCloudAgent(
      session.token,
      agentId,
      input,
    );
    setDefinitionsById((current) => ({
      ...current,
      [agent.agentId]: agent,
    }));
    return agent;
  }, [client, setDefinitionsById]);

  const archiveDefinition = useCallback(async (agentId: string) => {
    const session = await loadSession();
    if (!session?.token) {
      throw new Error('Sign in to Cloud before deleting an agent.');
    }
    const agent = await client.archiveCloudAgent(
      session.token,
      agentId,
    );
    setDefinitionsById((current) => {
      const { [agent.agentId]: _removed, ...rest } = current;
      return rest;
    });
    return agent;
  }, [client, setDefinitionsById]);

  return {
    refreshDefinitions,
    sharedAgents,
    refreshShared,
    createDefinition,
    updateDefinition,
    archiveDefinition,
  };
}
