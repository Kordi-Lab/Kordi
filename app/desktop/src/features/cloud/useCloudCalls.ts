import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  CLOUD_CALLS_CHANGED_EVENT,
  CloudCallClient,
  callMediaErrorMessage,
  cloudCallTargetForConversation,
  requestCallMediaAccess,
  type CloudCall,
  type CloudCallKind,
  type CloudCallsChangedDetail,
} from './cloudCalls';
import {
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudAuthClient,
} from './authClient';
import { loadSession } from './session';
import type {
  CloudCallsController,
  CloudCallPhase,
  CurrentCallState,
} from './cloudCallController';
import {
  activeCallsBySessionId,
  callMutationCompleted,
  callStartedOnAnotherDevice,
  conversationSessionId,
  isIncomingCallInvitation,
  newestCloudCallSnapshot,
  preferredCallEntry,
  reconcileCloudCallSnapshot,
  shouldApplyActiveCallSnapshot,
} from './cloudCallState';
import { useCloudCallMedia } from './useCloudCallMedia';
import { showCallWindow } from './callWindow';
import type { Conversation } from '@/kordi-app/types';

const ACTIVE_CALL_REFRESH_MS = 15_000;

export function useCloudCalls({
  account,
  conversations,
  client: clientOverride,
}: {
  account: CloudAccount | null;
  conversations: readonly Pick<Conversation, 'id' | 'canonicalSessionId'>[];
  client?: CloudAuthClient;
}): CloudCallsController {
  const client = useMemo(() => clientOverride ?? defaultCloudAuthClient(), [clientOverride]);
  const callClient = useMemo(() => new CloudCallClient(client), [client]);
  const [callsBySessionId, setCallsBySessionId] = useState<Record<string, CloudCall>>({});
  const [current, setCurrent] = useState<CurrentCallState | null>(null);
  const [phase, setPhase] = useState<CloudCallPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPresented, setIsPresented] = useState(false);
  const [detachedCallId, setDetachedCallId] = useState<string | null>(null);
  const [detachedThumbnailUrl, setDetachedThumbnailUrl] = useState<string | null>(null);
  const [isDetachedCallFolded, setDetachedCallFolded] = useState(false);
  const operationRef = useRef(0);
  const currentRef = useRef<CurrentCallState | null>(null);
  const locallyEndedCallIdsRef = useRef(new Set<string>());
  const callSnapshotGenerationRef = useRef(0);
  const activeCallsRequestRef = useRef(0);
  const activeAccountIdRef = useRef(account?.accountId ?? null);
  const {
    roomRef,
    clearRoom,
    connectMedia,
    refreshMediaDevices,
    toggleMicrophone,
    toggleCamera,
    resumeAudio,
    switchMediaDevice,
    clearMediaDevices,
    isMicrophoneEnabled,
    isCameraEnabled,
    isAudioPlaybackBlocked,
    connectedAtMs,
    mediaParticipants,
    mediaDevices,
    activeDeviceIds,
    canSelectAudioOutput,
  } = useCloudCallMedia({ operationRef, currentRef, setPhase, setError });

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const knownSessionIdsKey = conversations
    .map((conversation) => conversationSessionId(conversation))
    .sort()
    .join('\u0000');
  const knownSessionIds = useMemo(
    () => new Set(knownSessionIdsKey ? knownSessionIdsKey.split('\u0000') : []),
    [knownSessionIdsKey],
  );

  const updateCall = useCallback((call: CloudCall, sessionId?: string | null) => {
    const ended = call.state === 'ended' || Boolean(call.endedAt);
    callSnapshotGenerationRef.current += 1;
    if (ended) {
      locallyEndedCallIdsRef.current.add(call.id);
      setDetachedCallId((currentId) => currentId === call.id ? null : currentId);
      setDetachedThumbnailUrl(null);
      setDetachedCallFolded(false);
    }
    else if (locallyEndedCallIdsRef.current.has(call.id)) return;
    const resolvedSessionId = sessionId?.trim()
      || (currentRef.current?.call.id === call.id ? currentRef.current.sessionId : null);
    setCallsBySessionId((existing) => reconcileCloudCallSnapshot(existing, call, resolvedSessionId));
    setCurrent((existing) => existing?.call.id === call.id
      ? ended ? null : { ...existing, call: newestCloudCallSnapshot(existing.call, call) }
      : existing);
  }, []);

  const resetCurrent = useCallback(async ({ clearError = false }: { clearError?: boolean } = {}) => {
    operationRef.current += 1;
    currentRef.current = null;
    await clearRoom();
    setCurrent(null);
    setPhase('idle');
    setIsPresented(false);
    if (clearError) setError(null);
  }, [clearRoom]);

  useEffect(() => {
    const accountId = account?.accountId ?? null;
    if (activeAccountIdRef.current === accountId) return;
    activeAccountIdRef.current = accountId;
    locallyEndedCallIdsRef.current.clear();
    setDetachedCallId(null);
    setDetachedThumbnailUrl(null);
    setDetachedCallFolded(false);
    callSnapshotGenerationRef.current += 1;
    activeCallsRequestRef.current += 1;
    setCallsBySessionId({});
    clearMediaDevices();
    setError(null);
    void resetCurrent().catch(() => undefined);
  }, [account?.accountId, clearMediaDevices, resetCurrent]);

  const beginMediaSession = useCallback(async (
    kind: CloudCallKind,
    operation: number,
    load: () => Promise<{ call: CloudCall; media: { url: string; token: string } }>,
    nextCurrent: (call: CloudCall) => CurrentCallState,
  ) => {
    setError(null);
    setPhase('preparing');
    setIsPresented(true);
    try {
      await requestCallMediaAccess(kind);
      if (operationRef.current !== operation) return;
      setPhase('connecting');
      const session = await load();
      if (operationRef.current !== operation) return;
      const presented = nextCurrent(session.call);
      setCurrent(presented);
      currentRef.current = presented;
      updateCall(session.call, presented.sessionId);
      await connectMedia(session, presented, operation);
    } catch (caught) {
      if (operationRef.current !== operation) return;
      await clearRoom();
      setPhase('failed');
      setError(callMediaErrorMessage(caught));
    }
  }, [clearRoom, connectMedia, updateCall]);

  const start = useCallback(async (conversation: Conversation, kind: 'voice' | 'video') => {
    if (!account || roomRef.current || phase === 'preparing' || phase === 'connecting') return;
    const target = cloudCallTargetForConversation(account, conversation);
    if (!target) {
      setError('Calls are available in direct person chats and group conversations.');
      return;
    }
    const stored = await loadSession();
    if (!stored?.token) {
      setError('Sign in to Kordi Cloud before starting a call.');
      return;
    }
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const callKind = target.kind === 'group' ? 'meeting' : kind;
    await beginMediaSession(
      callKind,
      operation,
      () => callClient.start(stored.token, account.accountId, target, callKind),
      (call) => ({ call, sessionId: target.sessionId, direction: 'outgoing' }),
    );
  }, [account, beginMediaSession, callClient, phase, roomRef]);

  const join = useCallback(async (call: CloudCall, sessionId?: string | null) => {
    if (!account || roomRef.current || phase === 'preparing' || phase === 'connecting') return;
    const stored = await loadSession();
    if (!stored?.token) {
      setError('Sign in to Kordi Cloud before joining a call.');
      return;
    }
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const direction = callStartedOnAnotherDevice(call, account.accountId) ? 'handoff' : 'incoming';
    await beginMediaSession(
      call.kind,
      operation,
      () => callClient.join(stored.token, call.id),
      (joinedCall) => ({ call: joinedCall, sessionId: sessionId ?? null, direction }),
    );
  }, [account, beginMediaSession, callClient, phase, roomRef]);

  const decline = useCallback(async (call: CloudCall, sessionId?: string | null) => {
    const stored = await loadSession();
    if (!stored?.token) return null;
    try {
      const updated = await callClient.decline(stored.token, call.id);
      if (updated) updateCall(updated, sessionId);
      return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not decline the call.');
      return null;
    }
  }, [callClient, updateCall]);

  const leaveOrEnd = useCallback(async (action: 'leave' | 'end') => {
    const active = currentRef.current;
    if (!active) return;
    const stored = await loadSession();
    if (!stored?.token) {
      setError(`Could not ${action} the call because the Cloud session is unavailable. Sign in and try again.`);
      return;
    }
    try {
      const updated = action === 'end'
        ? await callClient.end(stored.token, active.call.id)
        : await callClient.leave(stored.token, active.call.id);
      if (!callMutationCompleted(action, active.call.kind, updated)) {
        throw new Error(`Kordi could not confirm that the call was ${action === 'end' ? 'ended' : 'left'}.`);
      }
      updateCall(updated, active.sessionId);
      setError(null);
      await resetCurrent();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action} the call.`);
    }
  }, [callClient, resetCurrent, updateCall]);

  const invite = useCallback(async () => {
    const active = currentRef.current;
    if (!active) return;
    const stored = await loadSession();
    if (!stored?.token) return;
    try {
      const updated = await callClient.invite(stored.token, active.call.id);
      if (updated) updateCall(updated, active.sessionId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not invite participants.');
    }
  }, [callClient, updateCall]);

  const refreshActiveCalls = useCallback(async () => {
    if (!account) {
      activeCallsRequestRef.current += 1;
      setCallsBySessionId({});
      return;
    }
    const request = activeCallsRequestRef.current + 1;
    activeCallsRequestRef.current = request;
    try {
      const snapshotGeneration = callSnapshotGenerationRef.current;
      const stored = await loadSession();
      if (!stored?.token) return;
      const calls = await callClient.listActive(stored.token);
      if (!shouldApplyActiveCallSnapshot(
        request,
        activeCallsRequestRef.current,
        snapshotGeneration,
        callSnapshotGenerationRef.current,
      )) return;
      const locallyEndedCallIds = locallyEndedCallIdsRef.current;
      const next = activeCallsBySessionId(calls, knownSessionIds, locallyEndedCallIds);
      setCallsBySessionId(next);
      const activeCurrent = currentRef.current;
      if (activeCurrent) {
        const latest = calls.find((entry) => entry.call.id === activeCurrent.call.id)?.call;
        if (locallyEndedCallIds.has(activeCurrent.call.id)
          || !latest
          || latest.state === 'ended'
          || latest.endedAt) await resetCurrent({ clearError: true });
        else setCurrent({ ...activeCurrent, call: latest });
      }
    } catch {
      // Realtime and the next repair poll can recover without interrupting an active call.
    }
  }, [account, callClient, knownSessionIds, resetCurrent]);

  useEffect(() => {
    if (!account || typeof window === 'undefined') return undefined;
    const initialRefresh = window.setTimeout(() => { void refreshActiveCalls(); }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshActiveCalls();
    }, ACTIVE_CALL_REFRESH_MS);
    const handleFocus = () => { void refreshActiveCalls(); };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, [account, refreshActiveCalls]);

  useEffect(() => {
    if (!account || typeof window === 'undefined') return undefined;
    const handleCallsChanged = (event: Event) => {
      const detail = (event as CustomEvent<CloudCallsChangedDetail>).detail;
      if (!detail || detail.accountId !== account.accountId) return;
      for (const entry of detail.calls) updateCall(entry.call, entry.sessionId);
      const active = currentRef.current;
      const ended = active && detail.calls.some((entry) => (
        entry.call.id === active.call.id
        && (entry.call.state === 'ended' || Boolean(entry.call.endedAt))
      ));
      if (ended) void resetCurrent({ clearError: true });
    };
    window.addEventListener(CLOUD_CALLS_CHANGED_EVENT, handleCallsChanged);
    return () => window.removeEventListener(CLOUD_CALLS_CHANGED_EVENT, handleCallsChanged);
  }, [account, resetCurrent, updateCall]);

  useEffect(() => () => {
    operationRef.current += 1;
  }, []);

  const entries = useMemo(() => Object.entries(callsBySessionId), [callsBySessionId]);
  const currentCall = current ? { call: current.call, sessionId: current.sessionId } : null;
  const incomingCall = useMemo(() => {
    if (!account || current) return null;
    return preferredCallEntry(entries, (call) => (
      call.id !== detachedCallId
        && isIncomingCallInvitation(call, account.accountId)
    ));
  }, [account, current, detachedCallId, entries]);
  const handoffCall = useMemo(() => {
    if (!account || current || incomingCall) return null;
    return preferredCallEntry(entries, (call) => (
      call.id !== detachedCallId
      &&
      callStartedOnAnotherDevice(call, account.accountId)
    ));
  }, [account, current, detachedCallId, entries, incomingCall]);
  const detachedCall = useMemo(() => {
    if (!detachedCallId) return null;
    const entry = entries.find(([, call]) => call.id === detachedCallId);
    return entry ? { sessionId: entry[0], call: entry[1] } : null;
  }, [detachedCallId, entries]);

  const moveToWindow = useCallback(async () => {
    const active = currentRef.current;
    if (!active) return;
    setDetachedCallId(active.call.id);
    setDetachedThumbnailUrl(null);
    setDetachedCallFolded(false);
    await resetCurrent();
  }, [resetCurrent]);

  const claimIncomingCallWindow = useCallback((callId: string) => {
    setDetachedCallId(callId);
    setDetachedThumbnailUrl(null);
    setDetachedCallFolded(false);
  }, []);

  return {
    account,
    callsBySessionId,
    currentCall,
    incomingCall,
    handoffCall,
    detachedCall,
    detachedThumbnailUrl,
    isDetachedCallFolded,
    phase,
    error,
    isPresented,
    isMicrophoneEnabled,
    isCameraEnabled,
    isAudioPlaybackBlocked,
    connectedAtMs,
    mediaParticipants,
    mediaDevices,
    activeDeviceIds,
    canSelectAudioOutput,
    targetForConversation: (conversation) => cloudCallTargetForConversation(account, conversation),
    callForConversation: (conversation) => callsBySessionId[conversationSessionId(conversation)] ?? null,
    start,
    join,
    decline,
    leave: () => leaveOrEnd('leave'),
    end: () => leaveOrEnd('end'),
    invite,
    toggleMicrophone,
    toggleCamera,
    resumeAudio,
    refreshMediaDevices,
    switchMediaDevice,
    show: () => setIsPresented(true),
    minimize: () => setIsPresented(false),
    moveToWindow,
    claimIncomingCallWindow,
    showWindow: async () => {
      setDetachedCallFolded(false);
      await showCallWindow();
    },
    clearDetachedCall: () => {
      setDetachedCallId(null);
      setDetachedThumbnailUrl(null);
      setDetachedCallFolded(false);
    },
    setDetachedCallFolded,
    updateDetachedThumbnail: setDetachedThumbnailUrl,
    dismissError: () => setError(null),
  };
}
