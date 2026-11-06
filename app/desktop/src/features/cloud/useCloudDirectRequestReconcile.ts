import { useEffect, useReducer, useRef } from 'react';

import type { CloudAccount, CloudAuthClient } from './authClient';
import { CLOUD_AGENT_MENTION_WINDOW_MS } from './cloudAgentMentionPolicy';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  cloudAgentRunStatusIsTerminal,
  cloudDirectRequestsAwaitingReply,
} from './cloudDirectRequestReconcile';
import { loadSession } from './session';

/** How long a request waits for its final reply before the run is looked up. */
export const CLOUD_DIRECT_REQUEST_RECONCILE_AFTER_MS = 20_000;
const RECHECK_MS = 15_000;
/** Lookups per request; a run that stays open is left to its own updates. */
const MAX_LOOKUPS = 6;

/**
 * Keeps a requester's view in step with runs on another person's agent. When
 * a request shows no final reply here but its run has ended on the server,
 * the conversation is fetched again, so the stored reply replaces the
 * waiting row instead of the request appearing to run forever.
 */
export function useCloudDirectRequestReconcile({
  account,
  client,
  messageIndex,
  initialMessagesSettled,
  refreshMessages,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: Pick<CloudAuthClient, 'lookupCloudAgentRunForRequest'>;
  messageIndex: CloudMessageIndex;
  initialMessagesSettled: boolean;
  refreshMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const [revision, recheck] = useReducer((value: number) => value + 1, 0);
  const lookupsRef = useRef(new Map<string, number>());
  const refreshedRef = useRef(new Set<string>());

  useEffect(() => {
    lookupsRef.current.clear();
    refreshedRef.current.clear();
  }, [account?.accountId]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const nowMs = Date.now();
    const awaiting = cloudDirectRequestsAwaitingReply({
      account,
      messageIndex,
      nowMs,
      minAgeMs: CLOUD_DIRECT_REQUEST_RECONCILE_AFTER_MS,
      windowMs: CLOUD_AGENT_MENTION_WINDOW_MS,
    }).filter(({ requestMessageId }) => (
      !refreshedRef.current.has(requestMessageId)
      && (lookupsRef.current.get(requestMessageId) ?? 0) < MAX_LOOKUPS
    ));
    let cancelled = false;
    let timer: number | null = null;
    // Requests that are still young get their first lookup once they are old enough.
    const pendingYoung = cloudDirectRequestsAwaitingReply({
      account,
      messageIndex,
      nowMs,
      minAgeMs: 0,
      windowMs: CLOUD_DIRECT_REQUEST_RECONCILE_AFTER_MS,
    }).length > 0;
    if (awaiting.length === 0) {
      if (pendingYoung) timer = window.setTimeout(recheck, RECHECK_MS);
      return () => { if (timer !== null) window.clearTimeout(timer); };
    }
    void (async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      let runEnded = false;
      for (const { requestMessageId } of awaiting) {
        if (cancelled) return;
        lookupsRef.current.set(requestMessageId, (lookupsRef.current.get(requestMessageId) ?? 0) + 1);
        const run = await client.lookupCloudAgentRunForRequest(session.token, requestMessageId).catch(() => null);
        if (run && cloudAgentRunStatusIsTerminal(run.status)) {
          refreshedRef.current.add(requestMessageId);
          runEnded = true;
        }
      }
      if (cancelled) return;
      if (runEnded) await refreshMessages();
    })().catch((error) => {
      reportWarning('[cloud-agent-request] reply reconcile failed', error);
    }).finally(() => {
      if (!cancelled) timer = window.setTimeout(recheck, RECHECK_MS);
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [account, client, initialMessagesSettled, messageIndex, refreshMessages, reportWarning, revision]);
}
