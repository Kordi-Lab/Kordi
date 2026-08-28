import { useEffect } from 'react';
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
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
import { recoverNativeCloudGroupHistory } from './cloudGroupNativeRecovery';
import { useCloudGroupReplay } from './useCloudGroupReplay';
import { useLegacyCloudGroupTitleNoticeRecovery } from './useLegacyCloudGroupTitleNoticeRecovery';
import { isNativeDesktopShell } from '@/lib/desktop';

export function useRecoveredCloudGroupReplay({
  account,
  activeConversationId,
  client,
  humanIdentityId,
  canonicalStateRef,
  setCanonicalState,
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
  initialMessagesSettled: boolean;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  coordinator: CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
  messageIndex: CloudMessageIndex;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
    options?: { deferPublish?: boolean; historyReplay?: boolean },
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
    && (
      nativeShell
      || (initialMessagesSettled && recoverySettled)
    )
  );
  const activeGroupSessionId = cloudSessionIdFromConversationId(
    activeConversationId ?? '',
  ) ?? activeConversationId?.trim() ?? '';

  useEffect(() => {
    if (!account || !activeGroupSessionId.startsWith('session:group:')) return;
    let active = true;
    void (async () => {
      const cloudSession = await loadSession();
      if (!cloudSession?.token || !active) return;
      const bootstrap = await client.bootstrapChatSync(cloudSession.token);
      const conversation = bootstrap.conversations.find((candidate) => (
        (candidate.legacy_session_id ?? candidate.id) === activeGroupSessionId
      ));
      if (!conversation || conversation.latest_message_sequence === 0) return;
      const page = await client.listChatConversationHistoryPage(
        cloudSession.token,
        conversation.id,
        undefined,
        50,
      );
      for (const snapshot of [...page.messages].reverse()) {
        if (!active) return;
        const wire = cloudMessageMetadataOnly(
          cloudMessageFromChatSync(snapshot, conversation, account.accountId),
        );
        const envelope = parseCloudGroupControl(wire.body);
        if (envelope) {
          await applyControl(wire, envelope, {
            deferPublish: true,
            historyReplay: true,
          });
        }
      }
      if (active) flushCanonicalState();
    })().catch((error) => {
      if (active) reportWarning('[cloud-group] selected history recovery failed', error);
    });
    return () => {
      active = false;
    };
  }, [account, activeGroupSessionId, applyControl, client, flushCanonicalState, reportWarning]);

  useEffect(() => {
    if (!account || !setCanonicalState) return;
    let active = true;
    let inFlight = false;
    let settled = false;
    const run = async () => {
      if (!active || inFlight || settled) return;
      inFlight = true;
      try {
        const recovered = await Promise.race([
          recoverNativeCloudGroupHistory({
            accountId: account.accountId,
            applyControl,
            flushCanonicalState,
            onSessionSettled: (sessionId) => onSessionSettled?.(sessionId),
            shouldContinue: () => active,
          }),
          new Promise<false>((resolve) => {
            globalThis.setTimeout(() => resolve(false), 15_000);
          }),
        ]);
        if (recovered && active) {
          settled = true;
          onNativeHistorySettled?.();
          onSettled?.();
        }
      } catch (error) {
        if (active) reportWarning('[cloud-group] native history recovery failed', error);
      } finally {
        inFlight = false;
      }
    };
    void run();
    const intervalId = globalThis.setInterval(() => void run(), 16_000);
    return () => {
      active = false;
      globalThis.clearInterval(intervalId);
    };
  }, [account, applyControl, flushCanonicalState, onNativeHistorySettled, onSessionSettled, onSettled, reportWarning, setCanonicalState]);
  useLegacyCloudGroupTitleNoticeRecovery({
    enabled: replayEnabled,
    contextKey,
    canonicalStateRef,
    setCanonicalState,
    messageIndex,
    reportWarning,
  });

  useCloudGroupReplay({
    enabled: replayEnabled,
    accountId: null,
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
