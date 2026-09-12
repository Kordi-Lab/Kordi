import { cloudMessageDeletions } from './cloudMessageDeletions';
import { useCloudRepairPolling } from './useCloudRepairPolling';
import { createCloudHistoryRepair } from './cloudHistoryRepair';
import {
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { chatSyncSessionTitle, cloudMessageFromChatSync } from './authClient';
import type { CloudMessage } from './authClient';
import { chatEventsRequireDirectoryBootstrap, publishCloudDeviceEvents } from './cloudDeviceEvents';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { compareCloudMessages } from './cloudMessageMerge';
import {
  cloudSessionForksByIdEqual,
  cloudMessagesByPeerEqual,
  cloudUnreadReadinessContextKey,
  mergeCloudMessagesByPeerSnapshot,
  transitionCloudUnreadReadiness,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import { syncCloudDiffOnce } from './cloudDiffSync';
import { hasCachedCloudSessionVisibility } from './cloudDiffSync';
import { commitCloudVisibility } from './cloudVisibilitySnapshot';
import type { CloudSessionTitlesById } from './cloudDiffSync';
import { mergeCloudSessionActivity } from './cloudSessionActivity';
import type {
  CloudMessageSyncController,
  PendingCloudSyncRequest,
  UseCloudMessageSyncInput,
} from './cloudMessageSync.types';
export type {
  CloudMessageSyncController,
  CloudMessageSyncStores,
  UseCloudMessageSyncInput,
} from './cloudMessageSync.types';
import { loadSession } from './session';
import {
  applyChatSyncLocalBatch,
  loadChatSyncConversations,
  loadChatSyncCoverage,
  loadChatSyncCursor,
  loadChatSyncLocalState,
} from '@/lib/desktopChatSync';
import { pruneMissingCanonicalCloudMessages } from '@/features/canonical/canonicalMessageSources';

export { CLOUD_MESSAGES_REFRESH_MS } from './cloudRepairPolling';
const CLOUD_SYNC_EVENT_PAGE_LIMIT = 1_000;

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
  refreshCloudAgents, onMessagesDeleted, onCanonicalMessagesPruned,
}: UseCloudMessageSyncInput): CloudMessageSyncController {
  const storesRef = useRef(stores);
  useEffect(() => { storesRef.current = stores; }, [stores]);
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
  } = stores.hiddenSessionIds;
  const {
    stateRef: deletedSessionIdsRef,
  } = stores.deletedSessionIds;
  const {
    stateRef: unreadSessionIdsRef,
  } = stores.unreadSessionIds;
  const {
    stateRef: pinnedSessionIdsRef,
  } = stores.pinnedSessionIds;
  const {
    stateRef: mutedSessionIdsRef,
  } = stores.mutedSessionIds;
  const {
    stateRef: pinnedGroupSpaceIdsRef,
  } = stores.pinnedGroupSpaceIds;
  const pendingRequestRef = useRef<PendingCloudSyncRequest | null>(null);
  const startupSnapshotContextRef = useRef<string | null>(null);
  const historyRepairRef = useRef(createCloudHistoryRepair());

  useEffect(() => {
    pendingRequestRef.current = null;
    startupSnapshotContextRef.current = null;
    historyRepairRef.current = createCloudHistoryRepair();
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
    if (!session?.token || session.accountId !== account.accountId) {
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
    let unreadSessionIds = unreadSessionIdsRef.current;
    let pinnedSessionIds = pinnedSessionIdsRef.current;
    let mutedSessionIds = mutedSessionIdsRef.current;
    let pinnedGroupSpaceIds = pinnedGroupSpaceIdsRef.current;
    let directoryBootstrapPending = false;
    let cursorOverride = forceBootstrap ? '0' : null;
    let bootstrapRecoveryAttempted = forceBootstrap;
    const deletedMessageIds = new Set<string>();
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
        unreadSessionIds,
        pinnedSessionIds,
        mutedSessionIds,
        pinnedGroupSpaceIds,
        shouldSaveCursor: () => coordinator.isCurrentGeneration(generation),
        loadCursor: async () => {
          if (cursorOverride) {
            const value = cursorOverride;
            cursorOverride = null;
            return value;
          }
          const local = await loadChatSyncCursor(account.accountId);
          return local?.cursor ?? '0';
        },
        commitResponse: async (response) => {
          if (!coordinator.isCurrentGeneration(generation)) throw new Error('Chat account changed during sync.');
          if (!response.chat) {
            throw new Error('Reliable chat sync returned a legacy response.');
          }
          commitCloudVisibility(account.accountId, storesRef.current, response.events);
          const local = await applyChatSyncLocalBatch({
            accountId: account.accountId,
            bootstrap: response.chat.bootstrap,
            cursor: response.chat.nextCursor,
            lastStreamSeq: response.chat.lastStreamSeq,
            conversations: response.chat.conversations,
            messages: response.chat.messages,
            events: response.chat.events,
          });
          if (!coordinator.isCurrentGeneration(generation)) return;
          if (response.chat.bootstrap || response.chat.conversations.length > 0
            || response.chat.messages.length > 0 || response.chat.events.length > 0) historyRepairRef.current.invalidate();
          publishCloudDeviceEvents(response.chat.events, account.accountId, session.deviceId, response.events);
          for (const event of response.events) if (event.eventType === 'message.deleted' && event.messageId) deletedMessageIds.add(event.messageId);
          directoryBootstrapPending ||= chatEventsRequireDirectoryBootstrap(response.chat.events);
          if (local) {
            await Promise.allSettled(local.changedConversationHeads.map((conversation) => (
              client.acknowledgeChatDelivery(
                session.token,
                conversation.conversationId,
                conversation.latestMessageSequence,
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
      unreadSessionIds = result.unreadSessionIds;
      pinnedSessionIds = result.pinnedSessionIds;
      mutedSessionIds = result.mutedSessionIds;
      pinnedGroupSpaceIds = result.pinnedGroupSpaceIds;
      if (!result.hasMore && directoryBootstrapPending) {
        directoryBootstrapPending = false;
        cursorOverride = '0';
        continue;
      }
      if (!result.hasMore) break;
    }
    if (cancelledRef.current || !coordinator.isCurrentGeneration(generation)) return;
    const suppressedMessageIds = new Set([...deletedMessageIds, ...cloudMessageDeletions.ids(account.accountId)]);
    messagesRef.current = mergeCloudMessagesByPeerSnapshot(messagesRef.current, messagesByPeer, suppressedMessageIds);
    setMessages((current) => {
      const merged = mergeCloudMessagesByPeerSnapshot(current, messagesByPeer, suppressedMessageIds);
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
    agentsRef.current = cloudAgentsById;
    setAgents((current) => (
      JSON.stringify(current) === JSON.stringify(cloudAgentsById) ? current : cloudAgentsById
    ));
    if (deletedMessageIds.size > 0) await onMessagesDeleted?.([...deletedMessageIds]);
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
    mutedSessionIdsRef,
    pinnedGroupSpaceIdsRef,
    messagesRef, onMessagesDeleted,
    pinsRef,
    pinnedSessionIdsRef,
    unreadSessionIdsRef,
    setActivity,
    setAgents,
    setForks,
    setMessages,
    setPins,
    setTitles,
    titlesRef,
  ]);

  const hydrateChatLocalState = useCallback(async (generation: number) => {
    if (!account || !coordinator.isCurrentGeneration(generation)) return;
    const local = await loadChatSyncLocalState(account.accountId);
    if (!local || !coordinator.isCurrentGeneration(generation)) return;
    if (!local.visibility) return;
    commitCloudVisibility(account.accountId, storesRef.current, [{eventId:'cached-visibility',eventType:'session.visibility.snapshot',
      peerAccountId:null,messageId:null,occurredAt:'',payload:{visibility:local.visibility}}]);
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
    if (!session?.token || session.accountId !== account.accountId || !coordinator.isCurrentGeneration(generation)) return;
    const [conversations, coverage] = await Promise.all([
      loadChatSyncConversations(account.accountId),
      loadChatSyncCoverage(account.accountId),
    ]);
    if (!coordinator.isCurrentGeneration(generation)) return;
    const coverageByConversation = new Map(coverage.map((value) => [value.conversationId, value]));
    for (const conversation of conversations) {
      if (!coordinator.isCurrentGeneration(generation)) return;
      if (conversation.latest_message_sequence <= 0) continue;
      const stored = coverageByConversation.get(conversation.id);
      const earliestSequence = stored?.earliestSequence;
      const hasLatest = stored?.latestSequence === conversation.latest_message_sequence;
      const hasContiguousSuffix = Boolean(
        hasLatest
        && earliestSequence
        && stored?.messageCount === stored.latestSequence - earliestSequence + 1,
      );
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
    if (!coordinator.isCurrentGeneration(generation)) return;
    const prunedMessageIds = await pruneMissingCanonicalCloudMessages(account.accountId); // Full hydration above makes absence authoritative.
    if (!coordinator.isCurrentGeneration(generation)) return;
    if (prunedMessageIds.length > 0) await onCanonicalMessagesPruned?.(prunedMessageIds);
  }, [account, client, coordinator, onCanonicalMessagesPruned]);
  const runCoordinatedSync = useCallback(async (generation: number) => {
    const request = pendingRequestRef.current;
    pendingRequestRef.current = null;
    if (!request) return;
    try {
      if (request.mode === 'bootstrap') {
        // Render the crash-safe local projection first. Catch-up and history
        // backfill then operate exclusively on the durable cursor stream.
        await Promise.all([hydrateChatLocalState(generation), refreshCloudAgents(generation).catch(() => {})]);
      }
      await syncDiffOnceForGeneration(generation, request.mode === 'full' || !hasCachedCloudSessionVisibility(account?.accountId));
      if (!coordinator.isCurrentGeneration(generation)) return;
      if (request.mode !== 'diff') historyRepairRef.current.invalidate();
      const hydration = historyRepairRef.current.run(() => hydrateMissingChatHistory(generation));
      if (hydration) {
        void hydration.then(() => markUnreadReadiness('ready', generation, bootstrapPeerKey))
          .catch(() => markUnreadReadiness('error', generation, bootstrapPeerKey));
      } else {
        markUnreadReadiness('ready', generation, bootstrapPeerKey);
      }
    } catch (error) {
      if (request.mode !== 'diff' || request.settleInitialMessages) {
        markUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      throw error;
    }
  }, [
    account,
    bootstrapPeerKey,
    coordinator,
    hydrateMissingChatHistory,
    hydrateChatLocalState,
    markUnreadReadiness,
    refreshCloudAgents,
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
      void bootstrapCloudMessages().catch(() => {
        if (startupSnapshotContextRef.current === cloudUnreadContextKey) {
          startupSnapshotContextRef.current = null;
        }
      });
    }
  }, [
    account,
    bootstrapCloudMessages,
    cloudUnreadContextKey,
    contactsSettled,
    coordinator,
    syncCloudCollaborationDiff,
  ]);
  const setRealtimeConnected = useCloudRepairPolling(
    account?.accountId,
    contactsSettled && Boolean(cloudUnreadContextKey),
    syncCloudCollaborationDiff,
  );
  return {
    refreshCloudMessages,
    syncCloudCollaborationDiff,
    setRealtimeConnected,
  };
}
