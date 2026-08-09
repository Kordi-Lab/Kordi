import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { upsertCanonicalMessageFast } from '@/lib/desktop';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionState,
  Contact,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAgentRunClaimInput,
  CloudAuthClient,
} from './authClient';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import {
  CLOUD_AGENT_MENTION_WINDOW_MS,
  cloudAgentMentionCandidates,
} from './cloudAgentMentionPolicy';
import {
  appendCloudGroupRequestingPlaceholder,
  cloudAgentRequestReachedCloud,
  cloudAgentRunAlreadyOwnsRequest,
  cloudFallbackRunAlreadyOwnsRequest,
  cloudGroupAgentUnavailableFallbackRequest,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  setCloudGroupRequestPlaceholderProcessing,
  upsertCanonicalRequestIntoLocalState,
  type CloudFallbackClaimAttemptResult,
} from './cloudAgentRequestState';
import {
  cloudFallbackClaimErrorIsRetryable,
  cloudFallbackClaimFailureDiagnostic,
} from './cloudFallbackClaimDiagnostics';
import {
  cloudGroupAgentMentionResponseState,
  cloudGroupAgentRequestingNoticeRequest,
} from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { loadSession } from './session';

export const CLOUD_GROUP_AGENT_STATUS_RECHECK_MS = 5_000;
export const CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS = 2 * 60_000;
export const CLOUD_SELF_AGENT_FALLBACK_TIMEOUT_MS = 2 * 60_000;

export type CloudFallbackRunClaimer = (
  claim: CloudAgentRunClaimInput,
  tokenOverride?: string | null,
) => Promise<CloudFallbackClaimAttemptResult>;

export function useCloudAgentAvailability({
  account,
  canonicalSessionState,
  canonicalSessionStateRef,
  setCanonicalSessionState,
  client,
  contacts,
  messageIndex,
  messageIndexRef,
  initialMessagesSettled,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalSessionState: CanonicalSessionState | null | undefined;
  canonicalSessionStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalSessionState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  client: CloudAuthClient;
  contacts: Contact[];
  messageIndex: CloudMessageIndex;
  messageIndexRef: MutableRefObject<CloudMessageIndex>;
  initialMessagesSettled: boolean;
  reportWarning: (message: string, error: unknown) => void;
}): CloudFallbackRunClaimer {
  const offlineTimersRef = useRef<Map<string, number>>(new Map());
  const claimedRunKeysRef = useRef<Set<string>>(new Set());
  const claimingRunKeysRef = useRef<Set<string>>(new Set());
  const [selfFallbackRevision, checkSelfFallback] = useReducer(
    (revision: number) => revision + 1,
    0,
  );

  useEffect(() => {
    claimedRunKeysRef.current.clear();
    claimingRunKeysRef.current.clear();
  }, [account?.accountId]);

  useEffect(() => () => {
    for (const timerId of offlineTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    offlineTimersRef.current.clear();
  }, []);

  const claimCloudFallbackRun = useCallback(async (
    claim: CloudAgentRunClaimInput,
    tokenOverride?: string | null,
  ): Promise<CloudFallbackClaimAttemptResult> => {
    if (claimedRunKeysRef.current.has(claim.idempotencyKey)) {
      return 'already-claimed';
    }
    if (claimingRunKeysRef.current.has(claim.idempotencyKey)) {
      return 'in-flight';
    }
    const token = tokenOverride?.trim() || (await loadSession())?.token?.trim();
    if (!token) return 'not-signed-in';
    claimingRunKeysRef.current.add(claim.idempotencyKey);
    try {
      const run = await client.claimCloudAgentRun(token, claim);
      if (!cloudAgentRunAlreadyOwnsRequest(run)) return 'terminal-failure';
      claimedRunKeysRef.current.add(claim.idempotencyKey);
      return 'claimed';
    } catch (error) {
      // Invite propagation and an already-owned exact run can race a fresh
      // group send. Retry only bounded transient failures; presence itself is
      // capability state and never owns a request.
      const retryable = cloudFallbackClaimErrorIsRetryable(error);
      reportWarning(
        '[cloud-agent-fallback] claim failed',
        cloudFallbackClaimFailureDiagnostic(error),
      );
      return retryable ? 'retryable-failure' : 'terminal-failure';
    } finally {
      claimingRunKeysRef.current.delete(claim.idempotencyKey);
    }
  }, [client, reportWarning]);

  useEffect(() => {
    if (!account || !canonicalSessionState || !setCanonicalSessionState) {
      for (const timerId of offlineTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      offlineTimersRef.current.clear();
      return;
    }

    // Bound the candidate walk to recent requests while retaining any older
    // request that already owns a requesting/offline placeholder.
    const offlineNoticeIdPattern = /^msg:cloud-agent-offline:(.+?):/;
    const keepStaleIds = new Set<string>();
    for (const message of canonicalSessionState.messages) {
      const match = offlineNoticeIdPattern.exec(message.id);
      if (match) keepStaleIds.add(match[1]);
    }

    const candidates = cloudAgentMentionCandidates(
      canonicalSessionState,
      account.accountId,
      {
        recentSinceMs: Date.now() - CLOUD_AGENT_MENTION_WINDOW_MS,
        keepStaleIds,
      },
    );
    const activeKeys = new Set<string>();

    for (const candidate of candidates) {
      const noticeId =
        `msg:cloud-agent-processing:${candidate.requestMessage.id}`
        + `:${candidate.targetAccountId}`;
      const key =
        `${candidate.requestMessage.id}\u001f${candidate.targetAccountId}`;
      const existingNotice = canonicalSessionState.messages.find(
        (message) => message.id === noticeId,
      );
      const hasRequestingNotice =
        existingNotice?.sourceTransport === 'cloud-group-agent-offline'
        && existingNotice.status !== 'failed';
      if (
        Date.now() - candidate.requestMessage.createdAtMs
          > CLOUD_AGENT_MENTION_WINDOW_MS
        && !hasRequestingNotice
      ) continue;
      activeKeys.add(key);
      const responseState = cloudGroupAgentMentionResponseState({
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        messages: canonicalSessionState.messages,
      });
      const requestReachedCloud = cloudAgentRequestReachedCloud(
        candidate.requestMessage,
      );
      const hasOfflineNotice = existingNotice?.status === 'failed';
      if (responseState || hasOfflineNotice) {
        const timerId = offlineTimersRef.current.get(key);
        if (timerId !== undefined) window.clearTimeout(timerId);
        offlineTimersRef.current.delete(key);
        setCanonicalSessionState((current) => {
          if (responseState === 'processing') {
            return setCloudGroupRequestPlaceholderProcessing(
              current,
              candidate,
              noticeId,
            );
          }
          if (responseState === 'terminal') {
            return removeCloudGroupPendingRowsForTerminalResponse(
              current,
              candidate.requestMessage.id,
              candidate.targetAccountId,
            );
          }
          return current;
        });
        continue;
      }
      if (offlineTimersRef.current.has(key)) continue;

      const requestDeadlineMs = candidate.requestMessage.createdAtMs
        + CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS;
      const persistUnavailableNotice = async () => {
        const failedNoticeRequest = cloudGroupAgentUnavailableFallbackRequest({
          sessionId: candidate.requestMessage.sessionId,
          requestMessageId: candidate.requestMessage.id,
          targetAccountId: candidate.targetAccountId,
          targetAgentDisplayName: candidate.targetAgentDisplayName,
          createdAtMs: Date.now(),
        });
        const persistedNotice = await upsertCanonicalMessageFast(
          failedNoticeRequest,
        );
        setCanonicalSessionState((current) =>
          mergeCanonicalMessageRow(current, persistedNotice)
        );
      };
      const scheduleStatusCheck = (delayMs: number) => {
        const timeoutId = window.setTimeout(() => {
          offlineTimersRef.current.delete(key);
          void checkRequestStatus().catch((error) => {
            reportWarning(
              '[cloud-group-agent-requesting] status check failed',
              error,
            );
            if (Date.now() < requestDeadlineMs) {
              scheduleStatusCheck(CLOUD_GROUP_AGENT_STATUS_RECHECK_MS);
            } else {
              void persistUnavailableNotice().catch((persistError) => {
                reportWarning(
                  '[cloud-group-agent-requesting] failed to persist unavailable notice',
                  persistError,
                );
              });
            }
          });
        }, delayMs);
        offlineTimersRef.current.set(key, timeoutId);
      };
      const checkRequestStatus = async () => {
        const latestState = canonicalSessionStateRef.current;
        const latestResponseState = latestState
          ? cloudGroupAgentMentionResponseState({
            requestMessageId: candidate.requestMessage.id,
            targetAccountId: candidate.targetAccountId,
            messages: latestState.messages,
          })
          : null;
        if (latestResponseState === 'terminal') {
          setCanonicalSessionState((current) =>
            removeCloudGroupPendingRowsForTerminalResponse(
              current,
              candidate.requestMessage.id,
              candidate.targetAccountId,
            )
          );
          return;
        }
        if (latestResponseState === 'processing') {
          setCanonicalSessionState((current) =>
            setCloudGroupRequestPlaceholderProcessing(
              current,
              candidate,
              noticeId,
            )
          );
          return;
        }

        const session = await loadSession();
        if (
          session?.token
          && await cloudFallbackRunAlreadyOwnsRequest({
            client,
            token: session.token,
            requestMessageId: candidate.requestMessage.id,
          })
        ) {
          setCanonicalSessionState((current) =>
            setCloudGroupRequestPlaceholderProcessing(
              current,
              candidate,
              noticeId,
            )
          );
          return;
        }

        const requestStillClaimable = (
          Date.now() - candidate.requestMessage.createdAtMs
          <= CLOUD_AGENT_MENTION_WINDOW_MS
        );
        const exactClaim = requestStillClaimable
          ? cloudFallbackRunClaimsForMessages({
            account,
            contacts,
            messageIndex: messageIndexRef.current,
            recentSinceMs: Date.now() - CLOUD_AGENT_MENTION_WINDOW_MS,
          }).find((claim) => (
            claim.requestMessageId === candidate.requestMessage.id
            && claim.ownerAccountId === candidate.targetAccountId
          )) ?? null
          : null;
        let claimResult: CloudFallbackClaimAttemptResult = 'retryable-failure';
        if (exactClaim) {
          claimedRunKeysRef.current.delete(exactClaim.idempotencyKey);
          claimResult = await claimCloudFallbackRun(
            exactClaim,
            session?.token,
          );
        }
        if (
          claimResult === 'claimed'
          || claimResult === 'already-claimed'
        ) {
          setCanonicalSessionState((current) =>
            setCloudGroupRequestPlaceholderProcessing(
              current,
              candidate,
              noticeId,
            )
          );
          return;
        }

        const remainingMs = requestDeadlineMs - Date.now();
        if (remainingMs > 0) {
          scheduleStatusCheck(
            Math.min(CLOUD_GROUP_AGENT_STATUS_RECHECK_MS, remainingMs),
          );
          return;
        }
        await persistUnavailableNotice();
      };
      const remainingBeforeFirstCheckMs = Math.max(
        0,
        requestDeadlineMs - Date.now(),
      );
      scheduleStatusCheck(
        Math.min(
          CLOUD_GROUP_AGENT_STATUS_RECHECK_MS,
          remainingBeforeFirstCheckMs,
        ),
      );

      if (hasRequestingNotice && requestReachedCloud) continue;

      const requestingNoticeRequest = cloudGroupAgentRequestingNoticeRequest({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs: Date.now(),
      });
      setCanonicalSessionState((current) =>
        upsertCanonicalRequestIntoLocalState(
          appendCloudGroupRequestingPlaceholder(current, candidate, noticeId),
          requestingNoticeRequest,
        )
      );
      void upsertCanonicalMessageFast(requestingNoticeRequest)
        .then((persistedNotice) => {
          setCanonicalSessionState((current) =>
            mergeCanonicalMessageRow(current, persistedNotice)
          );
        })
        .catch((error) => {
          reportWarning(
            '[cloud-group-agent-requesting] failed to persist processing notice',
            error,
          );
        });
    }

    for (const [key, timerId] of offlineTimersRef.current.entries()) {
      if (activeKeys.has(key)) continue;
      window.clearTimeout(timerId);
      offlineTimersRef.current.delete(key);
      const [requestMessageId, targetAccountId] = key.split('\u001f');
      if (requestMessageId && targetAccountId) {
        setCanonicalSessionState((current) =>
          removeCloudGroupOfflinePlaceholder(
            current,
            `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
          )
        );
      }
    }
  }, [
    account,
    canonicalSessionState,
    canonicalSessionStateRef,
    claimCloudFallbackRun,
    client,
    contacts,
    messageIndexRef,
    reportWarning,
    setCanonicalSessionState,
  ]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const selfAgentFallbackBeforeMs =
      Date.now() - CLOUD_SELF_AGENT_FALLBACK_TIMEOUT_MS;
    const claims = cloudFallbackRunClaimsForMessages({
      account,
      contacts,
      messageIndex,
      recentSinceMs: Date.now() - CLOUD_AGENT_MENTION_WINDOW_MS,
      selfAgentFallbackBeforeMs,
    }).filter(
      (claim) => !claimedRunKeysRef.current.has(claim.idempotencyKey),
    );
    if (claims.length === 0) return;
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token) return;
      for (const claim of claims) {
        if (cancelled) return;
        await claimCloudFallbackRun(claim, session.token);
      }
    })().catch((error) => {
      reportWarning(
        '[cloud-agent-fallback] self-agent recovery failed',
        error,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    claimCloudFallbackRun,
    contacts,
    initialMessagesSettled,
    messageIndex,
    reportWarning,
    selfFallbackRevision,
  ]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const pendingSelfClaims = cloudFallbackRunClaimsForMessages({
      account,
      contacts,
      messageIndex,
      recentSinceMs: Date.now() - CLOUD_AGENT_MENTION_WINDOW_MS,
      selfAgentFallbackBeforeMs: Number.POSITIVE_INFINITY,
    });
    if (!pendingSelfClaims.some(
      (claim) => claim.ownerAccountId === account.accountId,
    )) return;
    const timeoutId = window.setTimeout(
      checkSelfFallback,
      CLOUD_GROUP_AGENT_STATUS_RECHECK_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [
    account,
    contacts,
    initialMessagesSettled,
    messageIndex,
    selfFallbackRevision,
  ]);

  return claimCloudFallbackRun;
}
