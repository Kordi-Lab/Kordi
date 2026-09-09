import { useEffect, useRef, useState } from 'react';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { cancelDesktopChatTurn, fetchDesktopChatSessionActiveTurn, fetchDesktopChatTurnState, isNativeDesktopShell } from '@/lib/desktop';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import { CloudAuthClient } from '@/features/cloud/authClient';
import type { CloudAgentSubsession } from '@/features/cloud/agentSubsessionTypes';

// The shared transcript contains presentation IDs, not cancellable runtime IDs.
// Resolve the turn on this device, in the active account, before offering Stop.
export function useBackgroundSessionControl(sessionId: string, shared?: CloudAgentSubsession | null, accountId?: string) {
  const [turn, setTurn] = useState<DesktopChatTurnSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [revision, setRevision] = useState(0);
  const [remoteResult, setRemoteResult] = useState<CloudAgentSubsession | null>(null);
  const generation = useRef(0);
  const stopPending = useRef(false);

  useEffect(() => {
    const reset = () => {
      generation.current += 1;
      stopPending.current = false;
      setTurn(null);
      setRemoteResult(null);
      setError(null);
      setStopping(false);
      setRevision(value => value + 1);
    };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
    return () => window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    if (!isNativeDesktopShell()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: DesktopChatTurnSnapshot | null = null;
    const poll = async () => {
      try {
        const active = await fetchDesktopChatSessionActiveTurn(sessionId);
        const next = active ?? (last && !last.completed ? await fetchDesktopChatTurnState(last.id) : last);
        if (current !== generation.current) return;
        last = next;
        setTurn(next);
        if (next?.completed) { stopPending.current = false; setStopping(false); }
      } catch {
        // A stale shared status must not grant access to a different runtime.
        if (current !== generation.current) return;
        if (!last) setTurn(null);
        if (stopPending.current) {
          stopPending.current = false;
          setStopping(false);
          setError('Could not confirm that this task stopped. Try again.');
        }
      }
      if (current === generation.current) timer = setTimeout(() => { void poll(); }, last && !last.completed ? 1500 : 10000);
    };
    void poll();
    return () => { generation.current += 1; if (timer) clearTimeout(timer); };
  }, [sessionId, revision]);

  const visibleTurn = turn?.sessionId === sessionId ? turn : null;
  const remoteSnapshot = remoteResult?.sessionId === sessionId && remoteResult.ownerAccountId === accountId
    && remoteResult.version >= (shared?.version ?? 0) ? remoteResult : shared;
  const remoteExecutionIsNewer = !visibleTurn || (remoteSnapshot?.startedAtMs ?? 0) > (visibleTurn.startedAtMs ?? 0);
  const canStopRemotely = Boolean(remoteExecutionIsNewer && accountId && remoteSnapshot?.ownerAccountId === accountId && remoteSnapshot.status === 'running');
  const stop = async () => {
    if (stopPending.current || !(visibleTurn && !visibleTurn.completed) && !canStopRemotely) return;
    const current = generation.current;
    stopPending.current = true;
    setStopping(true);
    setError(null);
    try {
      if (!visibleTurn || visibleTurn.completed) {
        const session = await loadSession();
        if (!session || session.accountId !== accountId || session.accountId !== remoteSnapshot?.ownerAccountId) throw Error('Account changed.');
        const result = await new CloudAuthClient().stopAgentSubsession(session.token, sessionId, remoteSnapshot.startedAtMs ?? null);
        if (current !== generation.current) return;
        setRemoteResult(result);
        stopPending.current = false;
        setStopping(false);
        return;
      }
      const cancelled = await cancelDesktopChatTurn(visibleTurn.id);
      if (current !== generation.current) return;
      setTurn(cancelled);
      if (cancelled.completed) { stopPending.current = false; setStopping(false); }
    } catch {
      if (current !== generation.current) return;
      stopPending.current = false;
      setStopping(false);
      setError('Could not stop this task. Try again.');
    }
  };
  return { turn: visibleTurn, remoteSnapshot, canStop: Boolean(visibleTurn && !visibleTurn.completed) || canStopRemotely, stopping: stopping || !error && visibleTurn?.status === 'cancelling', error, stop };
}
