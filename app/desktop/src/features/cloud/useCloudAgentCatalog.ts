import {
  useCallback,
  useEffect,
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
import {
  CLOUD_AGENT_DIRECTORY_SYNC_EVENT,
  type CloudAgentDirectorySyncDetail,
} from './cloudDeviceEvents';

type CloudAgentCatalogStores = {
  definitionsByIdRef: MutableRefObject<
    Record<string, CloudAgentDefinition>
  >;
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
    definitionsByIdRef,
    setDefinitionsById,
    sharedByOwner,
    setSharedByOwner,
  } = stores;

  const commitDefinitions = useCallback((
    next: Record<string, CloudAgentDefinition>,
  ) => {
    definitionsByIdRef.current = next;
    setDefinitionsById((current) =>
      recordEqual(current, next) ? current : next
    );
  }, [definitionsByIdRef, setDefinitionsById]);

  const refreshDefinitions = useCallback(async (
    generation?: number,
  ) => {
    if (!account) {
      commitDefinitions({});
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
    commitDefinitions(next);
  }, [
    account,
    cancelledRef,
    client,
    commitDefinitions,
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
    const refreshed: Record<string, SharedCloudAgentSummary[]> = {};
    for (const agent of agents) {
      refreshed[agent.ownerAccountId] = [
        ...(refreshed[agent.ownerAccountId] ?? []),
        agent,
      ];
    }
    setSharedByOwner((current) => {
      const next = { ...current };
      owners.forEach((owner) => { delete next[owner]; });
      Object.assign(next, refreshed);
      return recordEqual(current, next) ? current : next;
    });
    return agents;
  }, [account, client, setSharedByOwner]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refreshChangedOwners = (event: Event) => {
      const ownerAccountIds = (event as CustomEvent<CloudAgentDirectorySyncDetail>)
        .detail?.ownerAccountIds ?? [];
      if (ownerAccountIds.length > 0) void refreshShared(ownerAccountIds);
    };
    window.addEventListener(CLOUD_AGENT_DIRECTORY_SYNC_EVENT, refreshChangedOwners);
    return () => window.removeEventListener(CLOUD_AGENT_DIRECTORY_SYNC_EVENT, refreshChangedOwners);
  }, [refreshShared]);

  const createDefinition = useCallback(async (
    input: CreateCloudAgentInput,
  ) => {
    const session = await loadSession();
    if (!session?.token) {
      throw new Error('Sign in to Cloud before creating an agent.');
    }
    const agent = await client.createCloudAgent(session.token, input);
    commitDefinitions({
      ...definitionsByIdRef.current,
      [agent.agentId]: agent,
    });
    return agent;
  }, [client, commitDefinitions, definitionsByIdRef]);

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
    commitDefinitions({
      ...definitionsByIdRef.current,
      [agent.agentId]: agent,
    });
    return agent;
  }, [client, commitDefinitions, definitionsByIdRef]);

  const archiveDefinition = useCallback(async (agentId: string) => {
    const session = await loadSession();
    if (!session?.token) {
      throw new Error('Sign in to Cloud before deleting an agent.');
    }
    const agent = await client.archiveCloudAgent(
      session.token,
      agentId,
    );
    const { [agent.agentId]: _removed, ...rest } =
      definitionsByIdRef.current;
    commitDefinitions(rest);
    return agent;
  }, [client, commitDefinitions, definitionsByIdRef]);

  return {
    refreshDefinitions,
    sharedAgents,
    refreshShared,
    createDefinition,
    updateDefinition,
    archiveDefinition,
  };
}
