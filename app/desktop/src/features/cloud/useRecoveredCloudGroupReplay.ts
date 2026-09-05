import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import { useEffect, useRef, useState } from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import { cloudSessionIdFromConversationId } from '@/features/collaboration/conversationIds';
import { loadSession } from './session';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { cloudMessageFromChatSync } from './chatSyncMapping';
import { parseCloudGroupControl, type CloudGroupControlEnvelope } from './cloudGroupMessages';
import type {
  CloudMessageIndex,
  IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
import { useCloudAgentTurnRecovery } from './useCloudAgentTurnRecovery';
import { useCloudGroupReplay } from './useCloudGroupReplay';
import { useLegacyCloudGroupTitleNoticeRecovery } from './useLegacyCloudGroupTitleNoticeRecovery';
import { isNativeDesktopShell } from '@/lib/desktop';
import { applyChatSyncLocalBatch } from '@/lib/desktopChatSync';

export function useRecoveredCloudGroupReplay({
  account,
  activeConversationId,
  client,
  humanIdentityId,
  canonicalStateRef,
  setCanonicalState,
  hydrateCanonicalSessionPage,
  initialMessagesSettled,
  processedRequestIdsRef,
  coordinator,
  messageIndex,
  applyControl,
  flushCanonicalState,
  onNativeHistorySettled,
  onSessionSettled,
  onSettled,
  reportWarning,
}: {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  client: CloudAuthClient;
  humanIdentityId?: string | null;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  hydrateCanonicalSessionPage?: (
    sessionId: string,
    options?: { beforeSequenceNum?: number | null; force?: boolean },
  ) => Promise<unknown>;
  initialMessagesSettled: boolean;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  coordinator: CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
  messageIndex: CloudMessageIndex;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
    options?: {
      deferPublish?: boolean;
      historyReplay?: boolean;
      catalogGroupTitle?: string | null;
    },
  ) => Promise<void>;
  flushCanonicalState: () => void;
  onNativeHistorySettled?: () => void;
  onSessionSettled?: (sessionId: string) => void;
  onSettled?: () => void;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const recoverySettled = useCloudAgentTurnRecovery({
    account,
    canonicalStateRef,
    setCanonicalState,
    initialMessagesSettled,
    processedRequestIdsRef,
    reportWarning,
  });
  const nativeShell = isNativeDesktopShell();
  const contextKey = account && (humanIdentityId || nativeShell)
    ? `${account.accountId}:${humanIdentityId || 'native'}`
    : null;
  const replayEnabled = Boolean(
    contextKey
    && setCanonicalState
    && initialMessagesSettled
    && (nativeShell || recoverySettled)
  );
  const activeSessionId = cloudSessionIdFromConversationId(
    activeConversationId ?? '',
  ) ?? activeConversationId?.trim() ?? '';
  const activeGroupSessionId = activeSessionId.startsWith('session:group:')
    ? activeSessionId
    : '';
  const accountId = account?.accountId ?? null;
  const replayCallbacksRef = useRef({
    applyControl,
    flushCanonicalState,
    reportWarning,
  });
  const bootstrapRef = useRef<{
    accountId: string;
    value: Awaited<ReturnType<CloudAuthClient['bootstrapChatSync']>>;
  } | null>(null);
  const [remoteCatalogAccountId, setRemoteCatalogAccountId] = useState<string | null>(null);
  const [activePageKey, setActivePageKey] = useState<string | null>(null);

  useEffect(() => {
    replayCallbacksRef.current = {
      applyControl,
      flushCanonicalState,
      reportWarning,
    };
  }, [applyControl, flushCanonicalState, reportWarning]);

  useEffect(() => {
    if (!nativeShell || !accountId || !setCanonicalState || !humanIdentityId?.trim()) return;
    let active = true;
    bootstrapRef.current = null;
    void (async () => {
      try {
        const cloudSession = await loadSession();
        if (!cloudSession?.token || !active) return;
        const bootstrap = await client.bootstrapChatSync(cloudSession.token);
        if (!active) return;
        bootstrapRef.current = { accountId, value: bootstrap };
        const groupConversations = bootstrap.conversations.filter(
          (conversation) => conversation.kind === 'group',
        );
        const conversationById = new Map(
          groupConversations.map((conversation) => [conversation.id, conversation]),
        );
        const headRows = bootstrap.latest_messages.flatMap((snapshot) => {
          const conversation = conversationById.get(snapshot.conversation_id);
          if (!conversation) return [];
          const wire = cloudMessageMetadataOnly(
            cloudMessageFromChatSync(snapshot, conversation, accountId),
          );
          const envelope = parseCloudGroupControl(wire.body);
          if (!envelope) return [];
          return [{ wire, envelope, conversation }];
        }).sort((left, right) => (
          Number(right.envelope.groupId === right.envelope.groupSpaceId)
          - Number(left.envelope.groupId === left.envelope.groupSpaceId)
        ));
        if (active) setRemoteCatalogAccountId(accountId);
        for (const row of headRows) {
          if (!active) return;
          await replayCallbacksRef.current.applyControl(row.wire, row.envelope, {
            deferPublish: true,
            historyReplay: true,
            catalogGroupTitle: row.conversation.group_title,
          });
          replayCallbacksRef.current.flushCanonicalState();
        }
      } catch (error) {
        if (active) {
          replayCallbacksRef.current.reportWarning(
            '[cloud-group] remote catalog recovery failed',
            error,
          );
        }
      } finally {
        if (active) {
          setRemoteCatalogAccountId(accountId);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [accountId, client, humanIdentityId, nativeShell, setCanonicalState]);

  const requestedActivePageKey = accountId && activeSessionId.startsWith('session:')
    ? `${accountId}:${activeSessionId}`
    : null;
  useEffect(() => {
    if (!accountId || !requestedActivePageKey || remoteCatalogAccountId !== accountId) return;
    if (activePageKey === requestedActivePageKey) return;
    let active = true;
    void (async () => {
      try {
        const bootstrap = bootstrapRef.current?.accountId === accountId
          ? bootstrapRef.current.value
          : null;
        const conversation = bootstrap?.conversations.find((candidate) => (
          (candidate.legacy_session_id ?? candidate.id) === activeSessionId
        ));
        const cloudSession = await loadSession();
        if (!conversation || !cloudSession?.token || !active) return;
        const page = await client.listChatConversationHistoryPage(
          cloudSession.token,
          conversation.id,
          undefined,
          100,
        );
        await applyChatSyncLocalBatch({
          accountId,
          bootstrap: false,
          conversations: [conversation],
          messages: page.messages,
        });
        for (const snapshot of [...page.messages].reverse()) {
          if (!active) return;
          const wire = cloudMessageMetadataOnly(
            cloudMessageFromChatSync(snapshot, conversation, accountId),
          );
          const envelope = parseCloudGroupControl(wire.body);
          if (!envelope) continue;
          await replayCallbacksRef.current.applyControl(wire, envelope, {
            deferPublish: true,
            historyReplay: true,
          });
        }
        if (active) replayCallbacksRef.current.flushCanonicalState();
        if (active) {
          await hydrateCanonicalSessionPage?.(
            activeSessionId,
            { force: true },
          );
        }
      } catch (error) {
        if (active) {
          replayCallbacksRef.current.reportWarning(
            '[cloud-group] active history recovery failed',
            error,
          );
        }
      } finally {
        if (active) setActivePageKey(requestedActivePageKey);
      }
    })();
    return () => {
      active = false;
    };
  }, [accountId, activePageKey, activeSessionId, client, hydrateCanonicalSessionPage, remoteCatalogAccountId, requestedActivePageKey]);

  const remoteCatalogReady = !nativeShell || remoteCatalogAccountId === accountId;
  const activePageReady = !requestedActivePageKey || activePageKey === requestedActivePageKey;
  const backgroundReplayEnabled = replayEnabled && remoteCatalogReady && activePageReady;

  useLegacyCloudGroupTitleNoticeRecovery({
    enabled: backgroundReplayEnabled,
    contextKey,
    canonicalStateRef,
    setCanonicalState,
    messageIndex,
    reportWarning,
  });

  useCloudGroupReplay({
    enabled: backgroundReplayEnabled,
    accountId: account?.accountId ?? null,
    prioritySessionId: activeGroupSessionId || null,
    contextKey,
    coordinator,
    messageIndex,
    canonicalStateRef,
    applyControl,
    flushCanonicalState,
    onNativeHistorySettled,
    onSessionSettled,
    onSettled,
    reportWarning,
  });
}
