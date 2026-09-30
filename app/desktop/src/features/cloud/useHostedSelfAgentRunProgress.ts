import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudAgentRun, CloudAgentRunClaimInput, CloudAuthClient, CloudMessage } from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  hostedSelfAgentRequestIsTerminal,
  removeHostedSelfAgentProgress,
  updateHostedSelfAgentProgress,
} from './hostedSelfAgentRunProgress';

const POLL_MS = 1_000;
const MAX_TRACK_MS = 10 * 60_000;

type TrackedRun = { timer: ReturnType<typeof setTimeout> | null; startedAtMs: number };

/** Shows only server-confirmed hosted runs in the local transcript. Never publishes a cloud message. */
export function useHostedSelfAgentRunProgress({
  accountId,
  client,
  messageIndexRef,
  setCanonicalSessionState,
}: {
  accountId: string | null | undefined;
  client: CloudAuthClient;
  messageIndexRef: MutableRefObject<CloudMessageIndex>;
  setCanonicalSessionState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
}) {
  const trackedRef = useRef(new Map<string, TrackedRun>());
  const generationRef = useRef(0);
  const activeAccountRef = useRef(accountId);
  const mountedRef = useRef(false);
  useLayoutEffect(() => { activeAccountRef.current = accountId; }, [accountId]);

  useEffect(() => {
    const tracked = trackedRef.current;
    generationRef.current += 1;
    mountedRef.current = true;
    return () => {
      generationRef.current += 1;
      mountedRef.current = false;
      for (const [requestId, entry] of tracked) {
        if (entry.timer) clearTimeout(entry.timer);
        setCanonicalSessionState?.((current) => removeHostedSelfAgentProgress(current, requestId));
      }
      tracked.clear();
    };
  }, [accountId, setCanonicalSessionState]);

  return useCallback((claim: CloudAgentRunClaimInput, run: CloudAgentRun, token: string) => {
    if (
      !accountId || !setCanonicalSessionState
      || !mountedRef.current || activeAccountRef.current !== accountId
      || claim.ownerAccountId !== accountId
      || claim.requesterAccountId !== accountId
      || !claim.runtimeRoute
      || run.executionBackend === 'desktop'
    ) return;
    const requestId = claim.requestMessageId.trim();
    if (!requestId || trackedRef.current.has(requestId)) return;
    const generation = generationRef.current;
    const entry: TrackedRun = { timer: null, startedAtMs: Date.now() };
    trackedRef.current.set(requestId, entry);

    const stop = () => {
      if (entry.timer) clearTimeout(entry.timer);
      trackedRef.current.delete(requestId);
      setCanonicalSessionState((current) => removeHostedSelfAgentProgress(current, requestId));
    };
    const refresh = (lastRun: CloudAgentRun) => {
      if (generation !== generationRef.current || activeAccountRef.current !== accountId || trackedRef.current.get(requestId) !== entry) return;
      const selfMessages = messageIndexRef.current.byPeerId.get(accountId) ?? [];
      const request: CloudMessage | undefined = selfMessages.find((message) => (
        message.messageId === requestId
        && message.fromAccountId === accountId
        && message.toAccountId === accountId
        && message.sessionId === claim.sessionId
      ));
      if (
        Date.now() - entry.startedAtMs >= MAX_TRACK_MS
        || hostedSelfAgentRequestIsTerminal(requestId, selfMessages)
        || !['queued', 'leased', 'running'].includes(lastRun.status.trim().toLowerCase())
      ) {
        stop();
        return;
      }
      if (request) {
        setCanonicalSessionState((current) => updateHostedSelfAgentProgress(current, {
          request,
          runStatus: lastRun.status,
          cloudMessages: messageIndexRef.current.byPeerId.get(accountId) ?? [],
        }));
      }
      entry.timer = setTimeout(async () => {
        if (generation !== generationRef.current || activeAccountRef.current !== accountId || trackedRef.current.get(requestId) !== entry) return;
        try {
          const nextRun = await client.lookupCloudAgentRunForRequest(token, requestId);
          if (generation !== generationRef.current || activeAccountRef.current !== accountId || trackedRef.current.get(requestId) !== entry) return;
          if (!nextRun) { stop(); return; }
          refresh(nextRun);
        } catch {
          // Keep the last confirmed phase during a transient lookup failure.
          if (generation === generationRef.current && activeAccountRef.current === accountId && trackedRef.current.get(requestId) === entry) {
            refresh(lastRun);
          }
        }
      }, POLL_MS);
    };
    refresh(run);
  }, [accountId, client, messageIndexRef, setCanonicalSessionState]);
}
