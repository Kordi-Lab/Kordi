import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { DesktopChatMessage, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail } from '@/lib/desktop';

import {
  appendDesktopSessionSourceMessageToCache,
  appendMappedSessionMessageToCache,
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
  const preloadFlightsRef = useRef(new Map<string, Promise<boolean>>());
  const [cachedChatSessionMessages, setCachedChatSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedProjectSessionMessages, setCachedProjectSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedDesktopSessionSourceMessages, setCachedDesktopSessionSourceMessages] = useState<Record<string, DesktopChatMessage[]>>({});
  const [hydratedDesktopSessionIds, setHydratedDesktopSessionIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    sourceCacheRef.current = cachedDesktopSessionSourceMessages;
  }, [cachedDesktopSessionSourceMessages]);

  const markSessionTranscriptHydrated = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || hydratedSessionIdsRef.current.has(normalizedSessionId)) return;
    const next = new Set(hydratedSessionIdsRef.current);
    next.add(normalizedSessionId);
    hydratedSessionIdsRef.current = next;
    setHydratedDesktopSessionIds(next);
  }, []);

  const mergeSessionTranscript = useCallback((
    sessionId: string,
    sourceMessages: DesktopChatMessage[],
    preserveExistingMessages: boolean,
    mappedMessagesOverride?: Message[],
  ) => {
    const mappedMessages = mappedMessagesOverride ?? mapDesktopMessages(sessionId, sourceMessages);
    sourceCacheRef.current = mergeDesktopSessionSourceMessagesCache(
      sourceCacheRef.current,
      sessionId,
      sourceMessages,
      preserveExistingMessages,
    );
    setCachedDesktopSessionSourceMessages((current) => mergeDesktopSessionSourceMessagesCache(
      current,
      sessionId,
      sourceMessages,
      preserveExistingMessages,
    ));
    setCachedChatSessionMessages((current) => mergeMappedSessionMessagesCache(
      current,
      sessionId,
      mappedMessages,
      preserveExistingMessages,
    ));
    setCachedProjectSessionMessages((current) => mergeMappedSessionMessagesCache(
      current,
      sessionId,
      mappedMessages,
      preserveExistingMessages,
    ));
    markSessionTranscriptHydrated(sessionId);
  }, [mapDesktopMessages, markSessionTranscriptHydrated]);

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
    sourceCacheRef.current = appendDesktopSessionSourceMessageToCache(
      sourceCacheRef.current,
      sessionId,
      sourceMessage,
    );
    setCachedChatSessionMessages((current) => appendMappedSessionMessageToCache(
      current,
      sessionId,
      mappedMessage,
    ));
    setCachedProjectSessionMessages((current) => appendMappedSessionMessageToCache(
      current,
      sessionId,
      mappedMessage,
    ));
    setCachedDesktopSessionSourceMessages((current) => appendDesktopSessionSourceMessageToCache(
      current,
      sessionId,
      sourceMessage,
    ));
    return true;
  }, [mapDesktopMessages]);

  const pruneKnownSessions = useCallback((knownSessionIds: ReadonlySet<string>) => {
    setCachedChatSessionMessages((current) => pruneDesktopSessionCacheByKnownSessions(current, knownSessionIds));
    setCachedProjectSessionMessages((current) => pruneDesktopSessionCacheByKnownSessions(current, knownSessionIds));
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
    if (hydratedSessionIdsRef.current.has(normalizedSessionId)) return Promise.resolve(true);
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
  }, [isNativeShell, liveTurnsBySessionRef, mergeSessionTranscript]);

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
