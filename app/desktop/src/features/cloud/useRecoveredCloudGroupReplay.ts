import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';
import type {
  CloudMessageIndex,
  IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
import { useCloudAgentTurnRecovery } from './useCloudAgentTurnRecovery';
import { useCloudGroupReplay } from './useCloudGroupReplay';
import { useLegacyCloudGroupTitleNoticeRecovery } from './useLegacyCloudGroupTitleNoticeRecovery';

export function useRecoveredCloudGroupReplay({
  account,
  humanIdentityId,
  canonicalStateRef,
  setCanonicalState,
  initialMessagesSettled,
  processedRequestIdsRef,
  coordinator,
  messageIndex,
  applyControl,
  flushCanonicalState,
  onSettled,
  reportWarning,
}: {
  account: CloudAccount | null;
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
  ) => Promise<void>;
  flushCanonicalState: () => void;
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
  const contextKey = account && humanIdentityId
    ? `${account.accountId}:${humanIdentityId}`
    : null;
  const replayEnabled = Boolean(
    contextKey
    && setCanonicalState
    && initialMessagesSettled
    && recoverySettled
  );

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
    accountId: account?.accountId ?? null,
    contextKey,
    coordinator,
    messageIndex,
    canonicalStateRef,
    applyControl,
    flushCanonicalState,
    onSettled,
    reportWarning,
  });
}
