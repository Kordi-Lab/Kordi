import {
  useCallback,
  useRef,
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
    hiddenIdsRef: MutableRefObject<Set<string>>;
    setDeletedIds: Dispatch<SetStateAction<Set<string>>>;
    setUnreadIds: Dispatch<SetStateAction<Set<string>>>;
    setLocallyReadIds: Dispatch<SetStateAction<Set<string>>>;
    setPinnedIds: Dispatch<SetStateAction<Set<string>>>;
    pinnedIdsRef: MutableRefObject<Set<string>>;
    setMutedIds: Dispatch<SetStateAction<Set<string>>>;
    setPinnedGroupSpaceIds: Dispatch<SetStateAction<Set<string>>>;
    pinnedGroupSpaceIdsRef: MutableRefObject<Set<string>>;
  };
  messages: {
    setByPeer: Dispatch<
      SetStateAction<Record<string, CloudMessage[]>>
    >;
  };
};

type IdPresenceMutation = {
  valueRef: MutableRefObject<Set<string>>;
  setValue: Dispatch<SetStateAction<Set<string>>>;
  id: string;
  present: boolean;
};

function setIdPresence(
  valueRef: MutableRefObject<Set<string>>,
  setValue: Dispatch<SetStateAction<Set<string>>>,
  id: string,
  present: boolean,
) {
  const previous = valueRef.current.has(id);
  if (previous === present) return previous;
  const next = new Set(valueRef.current);
  if (present) next.add(id);
  else next.delete(id);
  valueRef.current = next;
  setValue(next);
  return previous;
}

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
  const hiddenIdsRef = stores.visibility.hiddenIdsRef;
  const setDeletedIds = stores.visibility.setDeletedIds;
  const setUnreadIds = stores.visibility.setUnreadIds;
  const setLocallyReadIds = stores.visibility.setLocallyReadIds;
  const setPinnedIds = stores.visibility.setPinnedIds;
  const pinnedIdsRef = stores.visibility.pinnedIdsRef;
  const setMutedIds = stores.visibility.setMutedIds;
  const setPinnedGroupSpaceIds = stores.visibility.setPinnedGroupSpaceIds;
  const pinnedGroupSpaceIdsRef = stores.visibility.pinnedGroupSpaceIdsRef;
  const setMessagesByPeer = stores.messages.setByPeer;
  const visibilityRefreshGenerationRef = useRef(0);
  const visibilityMutationRevisionRef = useRef(new Map<string, number>());

  const beginVisibilityMutation = useCallback((key: string) => {
    const revision = (visibilityMutationRevisionRef.current.get(key) ?? 0) + 1;
    visibilityMutationRevisionRef.current.set(key, revision);
    visibilityRefreshGenerationRef.current += 1;
    return revision;
  }, []);

  const refreshVisibility = useCallback(async (token: string) => {
    const generation = ++visibilityRefreshGenerationRef.current;
    try {
      const visibility = await client.listSessionVisibility(token);
      if (generation !== visibilityRefreshGenerationRef.current) return;
      const ids = (values: string[]) => new Set(values.map((value) => value.trim()).filter(Boolean));
      setHiddenIds(ids(visibility.hiddenSessionIds));
      setDeletedIds(ids(visibility.deletedSessionIds));
      setUnreadIds(ids(visibility.unreadSessionIds));
      setPinnedIds(ids(visibility.pinnedSessionIds));
      setMutedIds(ids(visibility.mutedSessionIds));
      setPinnedGroupSpaceIds(ids(visibility.pinnedGroupSpaceIds));
    } catch {
      // The local mutation remains valid; the normal sync loop retries.
    }
  }, [client, setDeletedIds, setHiddenIds, setMutedIds, setPinnedGroupSpaceIds, setPinnedIds, setUnreadIds]);

  const runOptimisticVisibilityMutation = useCallback(async (
    mutationKey: string,
    mutations: IdPresenceMutation[],
    commit: (token: string) => Promise<void>,
  ) => {
    const revision = beginVisibilityMutation(mutationKey);
    const previous = mutations.map((mutation) => setIdPresence(
      mutation.valueRef,
      mutation.setValue,
      mutation.id,
      mutation.present,
    ));
    try {
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      await commit(session.token);
      void refreshVisibility(session.token);
    } catch (error) {
      if (visibilityMutationRevisionRef.current.get(mutationKey) === revision) {
        mutations.forEach((mutation, index) => setIdPresence(
          mutation.valueRef,
          mutation.setValue,
          mutation.id,
          previous[index] ?? false,
        ));
      }
      throw error;
    }
  }, [beginVisibilityMutation, refreshVisibility]);

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
    await runOptimisticVisibilityMutation(`hidden:${trimmedSessionId}`, [
      { valueRef: hiddenIdsRef, setValue: setHiddenIds, id: trimmedSessionId, present: true },
      { valueRef: pinnedIdsRef, setValue: setPinnedIds, id: trimmedSessionId, present: false },
    ], (token) => client.hideCloudSession(token, trimmedSessionId));
  }, [client, hiddenIdsRef, pinnedIdsRef, runOptimisticVisibilityMutation, setHiddenIds, setPinnedIds]);

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
    await runOptimisticVisibilityMutation(`pinned:${trimmedSessionId}`, [
      { valueRef: pinnedIdsRef, setValue: setPinnedIds, id: trimmedSessionId, present: pinned },
    ], (token) => client.setCloudSessionPinned(token, trimmedSessionId, pinned));
  }, [client, pinnedIdsRef, runOptimisticVisibilityMutation, setPinnedIds]);

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
    void refreshVisibility(session.token);
  }, [client, refreshVisibility, setMutedIds]);

  const setUnread = useCallback(async (sessionId: string, unread: boolean) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.setCloudSessionUnread(session.token, trimmedSessionId, unread);
    if (unread) {
      setLocallyReadIds((current) => {
        if (!current.has(trimmedSessionId)) return current;
        const next = new Set(current);
        next.delete(trimmedSessionId);
        return next;
      });
    }
    setUnreadIds((current) => {
      const next = new Set(current);
      if (unread) next.add(trimmedSessionId);
      else next.delete(trimmedSessionId);
      return next;
    });
    void refreshVisibility(session.token);
  }, [client, refreshVisibility, setLocallyReadIds, setUnreadIds]);

  const markRead = useCallback(async (sessionIds: string[]) => {
    const normalizedIds = [...new Set(sessionIds.map((value) => value.trim()).filter(Boolean))];
    if (normalizedIds.length === 0) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    setLocallyReadIds((current) => {
      const next = new Set(current);
      for (const sessionId of normalizedIds) next.add(sessionId);
      return next;
    });
    try {
      await Promise.all(normalizedIds.map(async (sessionId) => {
        await client.markSessionMessagesRead(session.token, sessionId);
        try {
          await client.setCloudSessionUnread(session.token, sessionId, false);
        } catch {
          // ponytail: preference cleanup is best-effort until every product server exposes chat-list actions.
        }
      }));
    } catch (error) {
      setLocallyReadIds((current) => new Set(
        [...current].filter((sessionId) => !normalizedIds.includes(sessionId)),
      ));
      throw error;
    }
    setUnreadIds((current) => {
      const next = new Set(current);
      for (const sessionId of normalizedIds) next.delete(sessionId);
      return next;
    });
    void refreshVisibility(session.token);
    void syncCollaborationDiff();
  }, [client, refreshVisibility, setLocallyReadIds, setUnreadIds, syncCollaborationDiff]);

  const setGroupPinned = useCallback(async (groupSpaceId: string, pinned: boolean) => {
    const trimmedGroupSpaceId = groupSpaceId.trim();
    if (!trimmedGroupSpaceId) return;
    await runOptimisticVisibilityMutation(`group-pinned:${trimmedGroupSpaceId}`, [{
      valueRef: pinnedGroupSpaceIdsRef,
      setValue: setPinnedGroupSpaceIds,
      id: trimmedGroupSpaceId,
      present: pinned,
    }], (token) => client.setCloudGroupSpacePinned(token, trimmedGroupSpaceId, pinned));
  }, [client, pinnedGroupSpaceIdsRef, runOptimisticVisibilityMutation, setPinnedGroupSpaceIds]);

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
    setUnreadIds((current) => {
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
    setUnreadIds,
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
    setUnread,
    markRead,
    setGroupPinned,
    remove,
  };
}
