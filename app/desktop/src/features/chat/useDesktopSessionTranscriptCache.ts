import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { DesktopChatMessage, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail } from '@/lib/desktop';

import {
  appendDesktopSessionSourceMessageToCache,
  appendMappedSessionMessageToCache,
  recentDesktopSessionIds,
  mergeDesktopSessionSourceMessagesCache,
  mergeMappedSessionMessagesCache,
  pruneDesktopSessionCacheByKnownSessions,
} from './desktopChatStateReducers';

type UseDesktopSessionTranscriptCacheArgs = {
  isNativeShell: boolean;
  mapDesktopMessages: (
    sessionId: string,
    messages: DesktopChatMessage[],
    sessionContext?: { metadata?: unknown },
  ) => Message[];
  liveTurnsBySessionRef: RefObject<Record<string, DesktopChatTurnSnapshot>>;
};

export function useDesktopSessionTranscriptCache({
  isNativeShell,
  mapDesktopMessages,
  liveTurnsBySessionRef,
}: UseDesktopSessionTranscriptCacheArgs) {
  const sourceCacheRef = useRef<Record<string, DesktopChatMessage[]>>({});
  const hydratedSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const recentSessionIdsRef = useRef<readonly string[]>([]);
  const preloadFlightsRef = useRef(new Map<string, Promise<boolean>>());
  const [cachedChatSessionMessages, setCachedChatSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedDesktopSessionSourceMessages, setCachedDesktopSessionSourceMessages] = useState<Record<string, DesktopChatMessage[]>>({});
  const [hydratedDesktopSessionIds, setHydratedDesktopSessionIds] = useState<ReadonlySet<string>>(new Set());
  const cachedProjectSessionMessages = cachedChatSessionMessages;

  useEffect(() => {
    sourceCacheRef.current = cachedDesktopSessionSourceMessages;
  }, [cachedDesktopSessionSourceMessages]);

  const retainedSessionIds = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    recentSessionIdsRef.current = recentDesktopSessionIds(
      recentSessionIdsRef.current,
      normalizedSessionId,
    );
    return new Set(recentSessionIdsRef.current);
  }, []);

  const mergeSessionTranscript = useCallback((
    sessionId: string,
    sourceMessages: DesktopChatMessage[],
    preserveExistingMessages: boolean,
    mappedMessagesOverride?: Message[],
  ) => {
    const retained = retainedSessionIds(sessionId);
    const mappedMessages = mappedMessagesOverride ?? mapDesktopMessages(sessionId, sourceMessages);
    sourceCacheRef.current = pruneDesktopSessionCacheByKnownSessions(
      mergeDesktopSessionSourceMessagesCache(
        sourceCacheRef.current,
        sessionId,
        sourceMessages,
        preserveExistingMessages,
      ),
      retained,
    );
    setCachedDesktopSessionSourceMessages((current) => pruneDesktopSessionCacheByKnownSessions(
      mergeDesktopSessionSourceMessagesCache(
        current,
        sessionId,
        sourceMessages,
        preserveExistingMessages,
      ),
      retained,
    ));
    setCachedChatSessionMessages((current) => pruneDesktopSessionCacheByKnownSessions(
      mergeMappedSessionMessagesCache(
        current,
        sessionId,
        mappedMessages,
        preserveExistingMessages,
      ),
      retained,
    ));
    const hydrated = new Set(
      [...hydratedSessionIdsRef.current].filter((id) => retained.has(id)),
    );
    hydrated.add(sessionId.trim());
    hydratedSessionIdsRef.current = hydrated;
    setHydratedDesktopSessionIds(hydrated);
  }, [mapDesktopMessages, retainedSessionIds]);

  const replaceSessionTranscript = useCallback((
    sessionId: string,
    sourceMessages: DesktopChatMessage[],
  ) => mergeSessionTranscript(sessionId, sourceMessages, false), [mergeSessionTranscript]);

  const appendSessionSourceMessage = useCallback((
    sessionId: string,
    sourceMessage: DesktopChatMessage,
  ) => {
    const mappedMessage = mapDesktopMessages(sessionId, [sourceMessage])[0];
    if (!mappedMessage) return false;
    const retained = retainedSessionIds(sessionId);
    sourceCacheRef.current = pruneDesktopSessionCacheByKnownSessions(
      appendDesktopSessionSourceMessageToCache(
        sourceCacheRef.current,
        sessionId,
        sourceMessage,
      ),
      retained,
    );
    setCachedChatSessionMessages((current) => pruneDesktopSessionCacheByKnownSessions(
      appendMappedSessionMessageToCache(current, sessionId, mappedMessage),
      retained,
    ));
    setCachedDesktopSessionSourceMessages((current) => pruneDesktopSessionCacheByKnownSessions(
      appendDesktopSessionSourceMessageToCache(current, sessionId, sourceMessage),
      retained,
    ));
    return true;
  }, [mapDesktopMessages, retainedSessionIds]);

  const pruneKnownSessions = useCallback((knownSessionIds: ReadonlySet<string>) => {
    recentSessionIdsRef.current = recentSessionIdsRef.current.filter((sessionId) => (
      knownSessionIds.has(sessionId)
    ));
    setCachedChatSessionMessages((current) => pruneDesktopSessionCacheByKnownSessions(current, knownSessionIds));
    setCachedDesktopSessionSourceMessages((current) => pruneDesktopSessionCacheByKnownSessions(current, knownSessionIds));
    const nextHydratedSessionIds = new Set(
      [...hydratedSessionIdsRef.current].filter((sessionId) => knownSessionIds.has(sessionId)),
    );
    if (nextHydratedSessionIds.size !== hydratedSessionIdsRef.current.size) {
      hydratedSessionIdsRef.current = nextHydratedSessionIds;
      setHydratedDesktopSessionIds(nextHydratedSessionIds);
    }
  }, []);

  const isDesktopSessionTranscriptCached = useCallback((sessionId: string) => (
    hydratedSessionIdsRef.current.has(sessionId.trim())
  ), []);

  const preloadDesktopSessionTranscript = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!isNativeShell || !normalizedSessionId) return Promise.resolve(false);
    if (hydratedSessionIdsRef.current.has(normalizedSessionId)) {
      retainedSessionIds(normalizedSessionId);
      return Promise.resolve(true);
    }
    const existingFlight = preloadFlightsRef.current.get(normalizedSessionId);
    if (existingFlight) return existingFlight;

    const request = fetchDesktopChatSessionDetail(normalizedSessionId)
      .then((detail) => {
        if (!detail || detail.id !== normalizedSessionId) return false;
        const liveTurn = liveTurnsBySessionRef.current[normalizedSessionId];
        mergeSessionTranscript(
          normalizedSessionId,
          detail.messages,
          Boolean(liveTurn && !liveTurn.completed),
        );
        return true;
      })
      .finally(() => preloadFlightsRef.current.delete(normalizedSessionId));
    preloadFlightsRef.current.set(normalizedSessionId, request);
    return request;
  }, [isNativeShell, liveTurnsBySessionRef, mergeSessionTranscript, retainedSessionIds]);

  return {
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    cachedDesktopSessionSourceMessages,
    hydratedDesktopSessionIds,
    mergeSessionTranscript,
    replaceSessionTranscript,
    appendSessionSourceMessage,
    pruneKnownSessions,
    isDesktopSessionTranscriptCached,
    preloadDesktopSessionTranscript,
  };
}
