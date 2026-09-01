import { useEffect, useReducer, type MutableRefObject } from 'react';

import type { Contact } from '@/kordi-app/types';
import type { CloudAccount, CloudAgentRunClaimInput } from './authClient';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import { CLOUD_AGENT_MENTION_WINDOW_MS } from './cloudAgentMentionPolicy';
import type { CloudFallbackClaimAttemptResult } from './cloudAgentRequestState';
import type { CloudMessageIndex } from './cloudMessageIndex';
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
  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const claims = cloudFallbackRunClaimsForMessages({
      account,
      contacts,
      messageIndex,
      recentSinceMs: Date.now() - CLOUD_AGENT_MENTION_WINDOW_MS,
    }).filter((claim) => (
      claim.ownerAccountId !== account.accountId
      && claim.idempotencyKey.startsWith('cloud-agent-fallback:')
      && !claimedRunKeysRef.current.has(claim.idempotencyKey)
    ));
    if (claims.length === 0) return;
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
    };
  }, [account, claimCloudFallbackRun, claimedRunKeysRef, contacts, initialMessagesSettled, messageIndex, recheckMs, reportWarning, revision]);
}
