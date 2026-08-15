import {
  useCallback,
  useEffect,
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
  ChatSyncMessage,
} from './authClient';
import { chatSyncSessionTitle, cloudMessageFromChatSync } from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import { publishCloudDeviceEvents } from './cloudDeviceEvents';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { compareCloudMessages } from './cloudMessageMerge';
import {
  cloudSessionForksByIdEqual,
  cloudMessagesByPeerEqual,
  cloudUnreadReadinessContextKey,
  mergeCloudMessagesByPeerSnapshot,
  transitionCloudUnreadReadiness,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import {
  syncCloudDiffOnce,
  type CloudSessionPinsById,
  type CloudSessionTitlesById,
} from './cloudDiffSync';
import {
  mergeCloudSessionActivity,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import { CloudSyncCoordinator } from './cloudSyncCoordinator';
import { loadSession } from './session';
import {
  applyChatSyncLocalBatch,
  loadChatSyncLocalState,
} from '@/lib/desktopChatSync';

// Realtime uses the Cloud WebSocket; this interval repairs missed frames and
// temporary disconnects without polling several times per second.
export const CLOUD_MESSAGES_REFRESH_MS = 15_000;
const CLOUD_SYNC_EVENT_PAGE_LIMIT = 1_000;

type PendingCloudSyncRequest = {
  mode: 'diff' | 'full' | 'bootstrap';
  settleInitialMessages: boolean;
};

type CloudSyncStore<T> = {
  stateRef: MutableRefObject<T>;
  setState: Dispatch<SetStateAction<T>>;
};

export type CloudMessageSyncStores = {
  messages: CloudSyncStore<Record<string, CloudMessage[]>> & {
    peerReadAtByPeerRef: MutableRefObject<Record<string, string>>;
  };
  activity: CloudSyncStore<CloudSessionActivityStore>;
  forks: CloudSyncStore<Record<string, CloudSessionForkSummary>>;
  pins: CloudSyncStore<CloudSessionPinsById>;
  titles: CloudSyncStore<CloudSessionTitlesById>;
  agents: CloudSyncStore<Record<string, CloudAgentDefinition>>;
  hiddenSessionIds: CloudSyncStore<Set<string>>;
  deletedSessionIds: CloudSyncStore<Set<string>>;
};

export type UseCloudMessageSyncInput = {
  account: CloudAccount | null;
  bootstrapPeerIds: string[];
  bootstrapPeerKey: string;
  cloudUnreadContextKey: string | null;
  contactsSettled: boolean;
  client: CloudAuthClient;
  coordinator: CloudSyncCoordinator;
  cancelledRef: MutableRefObject<boolean>;
  stores: CloudMessageSyncStores;
  setUnreadReadiness: Dispatch<SetStateAction<CloudUnreadReadinessSnapshot>>;
  refreshCloudAgents: (generation?: number) => Promise<void>;
};

export type CloudMessageSyncController = {
  refreshCloudMessages: () => Promise<void>;
  syncCloudCollaborationDiff: (
    options?: { settleInitialMessages?: boolean },
  ) => Promise<void>;
};

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function useCloudMessageSync({
  account,
  bootstrapPeerKey,
  cloudUnreadContextKey,
  contactsSettled,
  client,
  coordinator,
  cancelledRef,
  stores,
  setUnreadReadiness,
  refreshCloudAgents,
}: UseCloudMessageSyncInput): CloudMessageSyncController {
  const {
    stateRef: messagesRef,
    setState: setMessages,
  } = stores.messages;
  const { stateRef: activityRef, setState: setActivity } = stores.activity;
  const { stateRef: forksRef, setState: setForks } = stores.forks;
  const { stateRef: pinsRef, setState: setPins } = stores.pins;
  const { stateRef: titlesRef, setState: setTitles } = stores.titles;
  const { stateRef: agentsRef, setState: setAgents } = stores.agents;
  const {
    stateRef: hiddenSessionIdsRef,
    setState: setHiddenSessionIds,
  } = stores.hiddenSessionIds;
  const {
    stateRef: deletedSessionIdsRef,
    setState: setDeletedSessionIds,
  } = stores.deletedSessionIds;
  const pendingRequestRef = useRef<PendingCloudSyncRequest | null>(null);
  const startupSnapshotContextRef = useRef<string | null>(null);

  useEffect(() => {
    pendingRequestRef.current = null;
    startupSnapshotContextRef.current = null;
  }, [account?.accountId, coordinator]);

  const markUnreadReadiness = useCallback((
    status: CloudUnreadReadinessStatus,
    generation: number,
    peerKey: string,
  ) => {
    const accountId = account?.accountId;
    if (!accountId || !coordinator.isCurrentGeneration(generation)) return;
    const contextKey = cloudUnreadReadinessContextKey(accountId, generation, peerKey);
    setUnreadReadiness((current) => transitionCloudUnreadReadiness(
      current,
      status,
      contextKey,
    ));
  }, [account?.accountId, coordinator, setUnreadReadiness]);

  const syncDiffOnceForGeneration = useCallback(async (
    generation: number,
    forceBootstrap = false,
  ) => {
    if (!account || !coordinator.isCurrentGeneration(generation)) return;
    const session = await loadSession();
    if (!coordinator.isCurrentGeneration(generation)) return;
    if (!session?.token) {
      throw new Error('Cloud session is unavailable for reliable chat sync.');
    }
    await client.drainChatOutbox(session.token, account.accountId);
    if (!coordinator.isCurrentGeneration(generation)) return;
    let messagesByPeer = messagesRef.current;
    let sessionActivity = activityRef.current;
    let sessionForksById = forksRef.current;
    let sessionPinsById = pinsRef.current;
    let sessionTitlesById = titlesRef.current;
    let cloudAgentsById = agentsRef.current;
    let hiddenSessionIds = hiddenSessionIdsRef.current;
    let deletedSessionIds = deletedSessionIdsRef.current;
    let cursorOverride = forceBootstrap ? '0' : null;
    let bootstrapRecoveryAttempted = forceBootstrap;
    // A bootstrap cursor can be many pages behind the server (especially on a
    // fresh install). Keep the accumulated state private until the cursor is
    // exhausted so the sidebar never publishes a succession of partial
    // session catalogs and message counts.
    while (true) {
      const result = await syncCloudDiffOnce({
        accountId: account.accountId,
        messagesByPeer,
        sessionActivity,
        sessionForksById,
        sessionPinsById,
        sessionTitlesById,
        cloudAgentsById,
        hiddenSessionIds,
        deletedSessionIds,
        shouldSaveCursor: () => coordinator.isCurrentGeneration(generation),
        loadCursor: async () => {
          if (cursorOverride) {
            const value = cursorOverride;
            cursorOverride = null;
            return value;
          }
          const local = await loadChatSyncLocalState(account.accountId);
          return local?.cursor ?? '0';
        },
        commitResponse: async (response) => {
          if (!response.chat) {
            throw new Error('Reliable chat sync returned a legacy response.');
          }
          const local = await applyChatSyncLocalBatch({
            accountId: account.accountId,
            bootstrap: response.chat.bootstrap,
            cursor: response.chat.nextCursor,
            lastStreamSeq: response.chat.lastStreamSeq,
            conversations: response.chat.conversations,
            messages: response.chat.messages,
            events: response.chat.events,
          });
          publishCloudDeviceEvents(response.chat.events, account.accountId, session.deviceId, response.events);
          if (local) {
            await Promise.allSettled(local.conversations.map((conversation) => (
              client.acknowledgeChatDelivery(
                session.token,
                conversation.id,
                conversation.latest_message_sequence,
              )
            )));
          }
        },
        fetchEvents: (cursor) => client.syncCloudEvents(
          session.token,
          cursor,
          CLOUD_SYNC_EVENT_PAGE_LIMIT,
        ),
      });
      if (!coordinator.isCurrentGeneration(generation)) return;
      if (result.fallbackRequired) {
        if (bootstrapRecoveryAttempted) {
          throw new Error('Reliable chat sync and bootstrap both failed.');
        }
        bootstrapRecoveryAttempted = true;
        cursorOverride = '0';
        continue;
      }
      messagesByPeer = result.messagesByPeer;
      sessionActivity = result.sessionActivity;
      sessionForksById = result.sessionForksById;
      sessionPinsById = result.sessionPinsById;
      sessionTitlesById = result.sessionTitlesById;
      cloudAgentsById = result.cloudAgentsById;
      hiddenSessionIds = result.hiddenSessionIds;
      deletedSessionIds = result.deletedSessionIds;
      if (!result.hasMore) break;
    }
    if (cancelledRef.current || !coordinator.isCurrentGeneration(generation)) return;
    messagesRef.current = mergeCloudMessagesByPeerSnapshot(
      messagesRef.current,
      messagesByPeer,
    );
    setMessages((current) => {
      const merged = mergeCloudMessagesByPeerSnapshot(current, messagesByPeer);
      if (cloudMessagesByPeerEqual(current, merged)) return current;
      return merged;
    });
    setActivity((current) => mergeCloudSessionActivity(current, sessionActivity));
    setForks((current) => (
      cloudSessionForksByIdEqual(current, sessionForksById) ? current : sessionForksById
    ));
    setPins((current) => (
      JSON.stringify(current) === JSON.stringify(sessionPinsById) ? current : sessionPinsById
    ));
    setTitles((current) => (
      JSON.stringify(current) === JSON.stringify(sessionTitlesById) ? current : sessionTitlesById
    ));
    setAgents((current) => (
      JSON.stringify(current) === JSON.stringify(cloudAgentsById) ? current : cloudAgentsById
    ));
    setHiddenSessionIds((current) => (
      setsEqual(current, hiddenSessionIds) ? current : new Set(hiddenSessionIds)
    ));
    setDeletedSessionIds((current) => (
      setsEqual(current, deletedSessionIds) ? current : new Set(deletedSessionIds)
    ));
  }, [
    account,
    activityRef,
    agentsRef,
    cancelledRef,
    client,
    coordinator,
    deletedSessionIdsRef,
    forksRef,
    hiddenSessionIdsRef,
    messagesRef,
    pinsRef,
    setActivity,
    setAgents,
    setDeletedSessionIds,
    setForks,
    setHiddenSessionIds,
    setMessages,
    setPins,
    setTitles,
    titlesRef,
  ]);

  const hydrateChatLocalState = useCallback(async (generation: number) => {
    if (!account || !coordinator.isCurrentGeneration(generation)) return;
    const local = await loadChatSyncLocalState(account.accountId);
    if (!local || !coordinator.isCurrentGeneration(generation)) return;
    const conversationById = new Map(
      local.conversations.map((conversation) => [conversation.id, conversation]),
    );
    const hydratedMessages: Record<string, CloudMessage[]> = {};
    for (const snapshot of local.messages) {
      const conversation = conversationById.get(snapshot.conversation_id);
      if (!conversation) continue;
      const message = cloudMessageFromChatSync(snapshot, conversation, account.accountId);
      const peerId = message.fromAccountId === account.accountId
        ? message.toAccountId
        : message.fromAccountId;
      if (!peerId) continue;
      (hydratedMessages[peerId] ??= []).push(cloudMessageMetadataOnly(message));
    }
    for (const messages of Object.values(hydratedMessages)) {
      messages.sort(compareCloudMessages);
    }
    messagesRef.current = mergeCloudMessagesByPeerSnapshot(
      messagesRef.current,
      hydratedMessages,
    );
    setMessages((current) => mergeCloudMessagesByPeerSnapshot(current, hydratedMessages));
    const hydratedTitles = local.conversations.reduce<CloudSessionTitlesById>((titles, conversation) => {
      const sessionId = conversation.legacy_session_id ?? conversation.id;
      const title = chatSyncSessionTitle(conversation);
      if (!title) return titles;
      titles[sessionId] = {
        sessionId,
        title,
        titleSource: conversation.preferences.personal_title ? 'manual' as const : 'external' as const,
        titleRevision: conversation.version,
        titlePolicyVersion: 1,
        titleGeneratedFromMessageId: null,
        updatedAtMs: Date.parse(conversation.updated_at) || Date.now(),
        updatedByAccountId: conversation.created_by_account_id,
        updatedAt: conversation.updated_at,
      };
      return titles;
    }, {});
    setTitles((current) => ({ ...current, ...hydratedTitles }));
  }, [account, coordinator, messagesRef, setMessages, setTitles]);
  const hydrateMissingChatHistory = useCallback(async (generation: number) => {
    if (!account || !coordinator.isCurrentGeneration(generation)) return;
    const session = await loadSession();
    if (!session?.token || !coordinator.isCurrentGeneration(generation)) return;
    const local = await loadChatSyncLocalState(account.accountId);
    if (!local || !coordinator.isCurrentGeneration(generation)) return;
    const messagesByConversation = new Map<string, ChatSyncMessage[]>();
    for (const message of local.messages) {
      const values = messagesByConversation.get(message.conversation_id) ?? [];
      values.push(message);
      messagesByConversation.set(message.conversation_id, values);
    }
    for (const conversation of local.conversations) {
      if (!coordinator.isCurrentGeneration(generation)) return;
      if (conversation.latest_message_sequence <= 0) continue;
      const stored = messagesByConversation.get(conversation.id) ?? [];
      const storedSequences = [...new Set(stored
        .map((message) => message.conversation_sequence)
        .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0))]
        .sort((left, right) => left - right);
      const hasLatest = storedSequences[storedSequences.length - 1]
        === conversation.latest_message_sequence;
      const hasContiguousSuffix = hasLatest && storedSequences.every((sequence, index) => (
        index === 0 || sequence === storedSequences[index - 1] + 1
      ));
      const earliestSequence = storedSequences[0];
      if (hasContiguousSuffix && earliestSequence === 1) continue;
      // A clean bootstrap contains a contiguous suffix ending at the current
      // head, so page from its first item. If the local projection itself has
      // a middle gap, re-read the whole conversation instead of trusting the
      // presence of sequence one.
      let beforeSequence = hasContiguousSuffix ? earliestSequence : undefined;
      while (true) {
        const page = await client.listChatConversationHistoryPage(
          session.token,
          conversation.id,
          beforeSequence,
        );
        if (!coordinator.isCurrentGeneration(generation)) return;
        await applyChatSyncLocalBatch({
          accountId: account.accountId,
          bootstrap: false,
          messages: page.messages,
        });
        if (!page.hasMore) break;
        const next = page.nextBeforeSequence;
        if (!next || (beforeSequence !== undefined && next >= beforeSequence)) {
          throw new Error('Reliable chat history did not advance its sequence cursor.');
        }
        beforeSequence = next;
      }
    }
    await hydrateChatLocalState(generation);
  }, [account, client, coordinator, hydrateChatLocalState]);
  const runCoordinatedSync = useCallback(async (generation: number) => {
    const request = pendingRequestRef.current;
    pendingRequestRef.current = null;
    if (!request) return;
    try {
      if (request.mode === 'bootstrap') {
        // Render the crash-safe local projection first. Catch-up and history
        // backfill then operate exclusively on the durable cursor stream.
        await hydrateChatLocalState(generation);
      }
      await syncDiffOnceForGeneration(generation, request.mode === 'full');
      await hydrateMissingChatHistory(generation);
      markUnreadReadiness('ready', generation, bootstrapPeerKey);
    } catch (error) {
      if (request.mode !== 'diff' || request.settleInitialMessages) {
        markUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      throw error;
    }
  }, [
    bootstrapPeerKey,
    hydrateMissingChatHistory,
    hydrateChatLocalState,
    markUnreadReadiness,
    syncDiffOnceForGeneration,
  ]);
  const requestSync = useCallback((request: PendingCloudSyncRequest) => {
    const pending = pendingRequestRef.current;
    const mode = pending?.mode === 'bootstrap' || request.mode === 'bootstrap'
      ? 'bootstrap'
      : pending?.mode === 'full' || request.mode === 'full'
        ? 'full'
        : 'diff';
    const nextRequest = {
      mode,
      settleInitialMessages: Boolean(
        pending?.settleInitialMessages || request.settleInitialMessages,
      ),
    } satisfies PendingCloudSyncRequest;
    pendingRequestRef.current = nextRequest;
    if (nextRequest.mode !== 'diff') {
      markUnreadReadiness(
        'pending',
        coordinator.currentGeneration(),
        bootstrapPeerKey,
      );
    }
    return coordinator.request(runCoordinatedSync);
  }, [bootstrapPeerKey, coordinator, markUnreadReadiness, runCoordinatedSync]);
  const refreshCloudMessages = useCallback(() => requestSync({
    mode: 'full',
    settleInitialMessages: true,
  }), [requestSync]);
  const bootstrapCloudMessages = useCallback(() => requestSync({
    mode: 'bootstrap',
    settleInitialMessages: true,
  }), [requestSync]);
  const syncCloudCollaborationDiff = useCallback((
    options: { settleInitialMessages?: boolean } = {},
  ) => requestSync({
    mode: 'diff',
    settleInitialMessages: options.settleInitialMessages ?? true,
  }), [requestSync]);
  useEffect(() => {
    if (!account || !contactsSettled || !cloudUnreadContextKey) return;
    if (startupSnapshotContextRef.current !== cloudUnreadContextKey) {
      startupSnapshotContextRef.current = cloudUnreadContextKey;
      void refreshCloudAgents(coordinator.currentGeneration());
      void bootstrapCloudMessages().catch(() => {
        if (startupSnapshotContextRef.current === cloudUnreadContextKey) {
          startupSnapshotContextRef.current = null;
        }
      });
    }
    const interval = window.setInterval(() => {
      if (
        typeof document !== 'undefined'
        && document.visibilityState !== 'visible'
      ) return;
      void syncCloudCollaborationDiff();
    }, CLOUD_MESSAGES_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [
    account,
    bootstrapCloudMessages,
    cloudUnreadContextKey,
    contactsSettled,
    coordinator,
    refreshCloudAgents,
    syncCloudCollaborationDiff,
  ]);
  return {
    refreshCloudMessages,
    syncCloudCollaborationDiff,
  };
}
