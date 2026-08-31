import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudSessionForkSummary,
  UpsertCloudArtifactActivityInput,
  UpsertCloudTaskActivityInput,
} from './authClient';
import {
  removeCloudSessionMessages,
  type CloudSessionPinsById,
} from './cloudDiffSync';
import {
  cloneCloudSessionActivityForFork,
  mergeCloudSessionActivity,
  normalizeCloudSessionActivitySnapshot,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import {
  loadSession,
} from './session';

type CloudSessionActionStores = {
  activity: {
    valueRef: MutableRefObject<CloudSessionActivityStore>;
    setValue: Dispatch<SetStateAction<CloudSessionActivityStore>>;
  };
  forks: {
    setById: Dispatch<
      SetStateAction<Record<string, CloudSessionForkSummary>>
    >;
  };
  pins: {
    setById: Dispatch<SetStateAction<CloudSessionPinsById>>;
  };
  visibility: {
    setHiddenIds: Dispatch<SetStateAction<Set<string>>>;
    setDeletedIds: Dispatch<SetStateAction<Set<string>>>;
    setPinnedIds: Dispatch<SetStateAction<Set<string>>>;
    setMutedIds: Dispatch<SetStateAction<Set<string>>>;
  };
  messages: {
    setByPeer: Dispatch<
      SetStateAction<Record<string, CloudMessage[]>>
    >;
  };
};

export function useCloudSessionActions({
  account,
  client,
  stores,
  syncCollaborationDiff,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  stores: CloudSessionActionStores;
  syncCollaborationDiff: () => Promise<void>;
}) {
  const activityRef = stores.activity.valueRef;
  const setActivity = stores.activity.setValue;
  const setForksById = stores.forks.setById;
  const setPinsById = stores.pins.setById;
  const setHiddenIds = stores.visibility.setHiddenIds;
  const setDeletedIds = stores.visibility.setDeletedIds;
  const setPinnedIds = stores.visibility.setPinnedIds;
  const setMutedIds = stores.visibility.setMutedIds;
  const setMessagesByPeer = stores.messages.setByPeer;

  const refreshActivity = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!account || !trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) return;
    const snapshot = await client.listSessionActivity(
      session.token,
      trimmedSessionId,
    );
    const normalized = normalizeCloudSessionActivitySnapshot(snapshot);
    setActivity((current) =>
      mergeCloudSessionActivity(current, normalized)
    );
  }, [account, client, setActivity]);

  const publishTask = useCallback(async (
    input: UpsertCloudTaskActivityInput,
  ) => {
    if (!account) throw new Error('Not signed in.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const task = await client.upsertTaskActivity(session.token, input);
    setActivity((current) => mergeCloudSessionActivity(
      current,
      normalizeCloudSessionActivitySnapshot({
        tasks: [task],
        artifacts: [],
      }),
    ));
  }, [account, client, setActivity]);

  const publishArtifact = useCallback(async (
    input: UpsertCloudArtifactActivityInput,
  ) => {
    if (!account) throw new Error('Not signed in.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const artifact = await client.upsertArtifactActivity(
      session.token,
      input,
    );
    setActivity((current) => mergeCloudSessionActivity(
      current,
      normalizeCloudSessionActivitySnapshot({
        tasks: [],
        artifacts: [artifact],
      }),
    ));
  }, [account, client, setActivity]);

  const recordFork = useCallback(async (input: {
    sourceSessionId: string;
    forkSessionId: string;
    parentMessageId?: string | null;
  }) => {
    if (!account) throw new Error('Not signed in.');
    const sourceSessionId = input.sourceSessionId.trim();
    const forkSessionId = input.forkSessionId.trim();
    if (!sourceSessionId || !forkSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const fork = await client.createSessionFork(
      session.token,
      sourceSessionId,
      {
        forkSessionId,
        parentMessageId: input.parentMessageId ?? null,
      },
    );
    setForksById((current) => ({
      ...current,
      [fork.forkSessionId]: fork,
    }));
    const cloned = cloneCloudSessionActivityForFork(
      activityRef.current,
      sourceSessionId,
      forkSessionId,
      new Date().toISOString(),
    );
    setActivity((current) =>
      mergeCloudSessionActivity(current, cloned)
    );
    void refreshActivity(forkSessionId);
  }, [
    account,
    activityRef,
    client,
    refreshActivity,
    setActivity,
    setForksById,
  ]);

  const updatePin = useCallback(async (input: {
    sessionId: string;
    messageId: string | null;
    scope: 'private' | 'shared';
  }) => {
    if (!account) {
      throw new Error('Cloud account is not signed in.');
    }
    const trimmedSessionId = input.sessionId.trim();
    if (!trimmedSessionId) throw new Error('Session id is required.');
    const session = await loadSession();
    if (!session?.token) {
      throw new Error('Cloud session is not available.');
    }
    const pin = await client.updateCloudSessionPin(
      session.token,
      trimmedSessionId,
      {
        messageId: input.messageId?.trim() || null,
        scope: input.scope,
      },
    );
    setPinsById((current) => ({
      ...current,
      [pin.sessionId]: pin,
    }));
    void syncCollaborationDiff();
    return pin;
  }, [account, client, setPinsById, syncCollaborationDiff]);

  const hide = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.hideCloudSession(session.token, trimmedSessionId);
    setHiddenIds((current) =>
      new Set(current).add(trimmedSessionId)
    );
    setPinnedIds((current) => {
      if (!current.has(trimmedSessionId)) return current;
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
  }, [client, setHiddenIds, setPinnedIds]);

  const unhide = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.unhideCloudSession(session.token, trimmedSessionId);
    setHiddenIds((current) => {
      if (!current.has(trimmedSessionId)) return current;
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
    setDeletedIds((current) => {
      if (!current.has(trimmedSessionId)) return current;
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
  }, [client, setDeletedIds, setHiddenIds]);

  const setPinned = useCallback(async (sessionId: string, pinned: boolean) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.setCloudSessionPinned(session.token, trimmedSessionId, pinned);
    setPinnedIds((current) => {
      const next = new Set(current);
      if (pinned) next.add(trimmedSessionId);
      else next.delete(trimmedSessionId);
      return next;
    });
  }, [client, setPinnedIds]);

  const setMuted = useCallback(async (sessionId: string, muted: boolean) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.setCloudSessionMuted(session.token, trimmedSessionId, muted);
    setMutedIds((current) => {
      const next = new Set(current);
      if (muted) next.add(trimmedSessionId);
      else next.delete(trimmedSessionId);
      return next;
    });
  }, [client, setMutedIds]);

  const remove = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.deleteCloudSession(session.token, trimmedSessionId);
    setHiddenIds((current) => {
      if (!current.has(trimmedSessionId)) return current;
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
    setDeletedIds((current) =>
      new Set(current).add(trimmedSessionId)
    );
    setPinnedIds((current) => {
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
    setMutedIds((current) => {
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
    if (account) {
      setMessagesByPeer((current) =>
        removeCloudSessionMessages(
          account.accountId,
          current,
          trimmedSessionId,
        )
      );
    }
  }, [
    account,
    client,
    setDeletedIds,
    setHiddenIds,
    setMessagesByPeer,
    setMutedIds,
    setPinnedIds,
  ]);

  return {
    refreshActivity,
    publishTask,
    publishArtifact,
    recordFork,
    updatePin,
    hide,
    unhide,
    setPinned,
    setMuted,
    remove,
  };
}
