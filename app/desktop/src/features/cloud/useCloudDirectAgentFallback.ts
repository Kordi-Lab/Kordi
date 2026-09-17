import { useEffect, useReducer, useRef, type MutableRefObject } from 'react';

import type { Contact } from '@/kordi-app/types';
import type { CloudAccount, CloudAgentRunClaimInput } from './authClient';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import { CLOUD_AGENT_MENTION_WINDOW_MS } from './cloudAgentMentionPolicy';
import type { CloudFallbackClaimAttemptResult } from './cloudAgentRequestState';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { voiceAgentWaitingSince, voiceReadyForStoredPrompt } from './cloudVoiceAgentGate';
import { useCloudVoiceTranscriptSettledVersion } from './cloudVoiceTranscriptPersistence';
import { loadSession } from './session';

export function useCloudDirectAgentFallback({
  account,
  contacts,
  messageIndex,
  initialMessagesSettled,
  claimCloudFallbackRun,
  claimedRunKeysRef,
  reportWarning,
  recheckMs,
}: {
  account: CloudAccount | null;
  contacts: Contact[];
  messageIndex: CloudMessageIndex;
  initialMessagesSettled: boolean;
  claimCloudFallbackRun: (claim: CloudAgentRunClaimInput, token?: string | null) => Promise<CloudFallbackClaimAttemptResult>;
  claimedRunKeysRef: MutableRefObject<Set<string>>;
  reportWarning: (message: string, error: unknown) => void;
  recheckMs: number;
}) {
  const [revision, recheck] = useReducer((value: number) => value + 1, 0);
  const voiceTranscriptSettledVersion = useCloudVoiceTranscriptSettledVersion();
  const voiceWaitingSinceRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const nowMs = Date.now();
    let voiceWaitUntilMs = Number.POSITIVE_INFINITY;
    const claims = cloudFallbackRunClaimsForMessages({
      account,
      contacts,
      messageIndex,
      recentSinceMs: nowMs - CLOUD_AGENT_MENTION_WINDOW_MS,
    }).filter((claim) => (
      claim.ownerAccountId !== account.accountId
      && claim.idempotencyKey.startsWith('cloud-agent-fallback:')
      && !claimedRunKeysRef.current.has(claim.idempotencyKey)
    )).filter((claim) => {
      // The run prompt is built from the stored message when claimed; wait for the sender's voice transcript.
      const request = messageIndex.byMessageId.get(claim.requestMessageId);
      const gate = voiceReadyForStoredPrompt({
        messageId: claim.requestMessageId,
        voice: request?.voiceMessage,
        createdAt: request?.createdAt,
        waitingSinceMs: voiceAgentWaitingSince(voiceWaitingSinceRef.current, claim.requestMessageId, nowMs),
        nowMs,
      });
      if (gate.status === 'waiting') {
        voiceWaitUntilMs = Math.min(voiceWaitUntilMs, gate.retryAtMs);
        return false;
      }
      voiceWaitingSinceRef.current.delete(claim.requestMessageId);
      return true;
    });
    const voiceWaitTimer = Number.isFinite(voiceWaitUntilMs)
      ? window.setTimeout(recheck, Math.max(0, voiceWaitUntilMs - Date.now()))
      : null;
    if (claims.length === 0) {
      return voiceWaitTimer === null ? undefined : () => window.clearTimeout(voiceWaitTimer);
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    void (async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      let shouldRetry = false;
      for (const claim of claims) {
        if (cancelled) return;
        const result = await claimCloudFallbackRun(claim, session.token);
        shouldRetry ||= result === 'retryable-failure' || result === 'in-flight';
      }
      if (shouldRetry && !cancelled) retryTimer = window.setTimeout(recheck, recheckMs);
    })().catch((error) => {
      reportWarning('[cloud-agent-fallback] direct claim failed', error);
      if (!cancelled) retryTimer = window.setTimeout(recheck, recheckMs);
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (voiceWaitTimer !== null) window.clearTimeout(voiceWaitTimer);
    };
  }, [account, claimCloudFallbackRun, claimedRunKeysRef, contacts, initialMessagesSettled, messageIndex, recheckMs, reportWarning, revision, voiceTranscriptSettledVersion]);
}
