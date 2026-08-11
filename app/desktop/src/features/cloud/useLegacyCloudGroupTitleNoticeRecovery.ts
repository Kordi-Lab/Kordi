import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { canonicalMessagesEqual } from '@/features/canonical/canonicalEquality';
import type { CanonicalSessionState } from '@/kordi-app/types';
import {
  classifyLegacyCloudGroupTitleNotices,
  listLegacyCloudGroupTitleNoticeIds,
  type LegacyCloudGroupTitleNoticeClassificationDelta,
} from './legacyCloudGroupTitleNoticeDesktop';
import { legacyCloudGroupTitleNoticeClassifications } from './legacyCloudGroupTitleNotices';
import type { CloudMessageIndex } from './cloudMessageIndex';

export function applyLegacyCloudGroupTitleNoticeClassificationDelta(
  state: CanonicalSessionState | null,
  delta: LegacyCloudGroupTitleNoticeClassificationDelta,
): CanonicalSessionState | null {
  if (!state) return state;
  const classifiedById = new Map(delta.messages.map((message) => [message.id, message]));
  let messagesChanged = false;
  const messages = state.messages.map((message) => {
    const classified = classifiedById.get(message.id);
    if (!classified || canonicalMessagesEqual(message, classified)) return message;
    messagesChanged = true;
    return classified;
  });
  const repairBySessionId = new Map(
    delta.sessionRepairs.map((repair) => [repair.sessionId, repair]),
  );
  let sessionsChanged = false;
  const sessions = state.sessions.map((session) => {
    const repair = repairBySessionId.get(session.id);
    if (!repair || (session.lastMessageAtMs ?? 0) > repair.replacedThroughAtMs) return session;
    const lastMessageAtMs = repair.lastMessageAtMs;
    if ((session.lastMessageAtMs ?? null) === lastMessageAtMs) return session;
    sessionsChanged = true;
    return { ...session, lastMessageAtMs };
  });
  if (!messagesChanged && !sessionsChanged) return state;
  return {
    ...state,
    messages: messagesChanged ? messages : state.messages,
    sessions: sessionsChanged ? sessions : state.sessions,
  };
}

async function recoverLegacyCloudGroupTitleNotices({
  messageIndex,
}: {
  messageIndex: CloudMessageIndex;
}): Promise<LegacyCloudGroupTitleNoticeClassificationDelta> {
  const candidateMessageIds = await listLegacyCloudGroupTitleNoticeIds();
  if (candidateMessageIds.length === 0) {
    return { messages: [], sessionRepairs: [] };
  }
  const cachedMessages = candidateMessageIds.flatMap((messageId) => {
    const message = messageIndex.byMessageId.get(messageId);
    return message ? [message] : [];
  });
  const classifications = legacyCloudGroupTitleNoticeClassifications(
    candidateMessageIds,
    cachedMessages,
  );
  return classifyLegacyCloudGroupTitleNotices(classifications);
}

export function useLegacyCloudGroupTitleNoticeRecovery({
  enabled,
  contextKey,
  canonicalStateRef,
  setCanonicalState,
  messageIndex,
  reportWarning,
}: {
  enabled: boolean;
  contextKey: string | null;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  messageIndex: CloudMessageIndex;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const reportWarningRef = useRef(reportWarning);
  const completedContextKeyRef = useRef<string | null>(null);
  const recoveryRef = useRef<{
    contextKey: string;
    promise: Promise<LegacyCloudGroupTitleNoticeClassificationDelta>;
  } | null>(null);
  useEffect(() => {
    reportWarningRef.current = reportWarning;
  }, [reportWarning]);

  useEffect(() => {
    if (
      !enabled
      || !contextKey
      || !setCanonicalState
      || completedContextKeyRef.current === contextKey
    ) return;
    let active = true;
    const existing = recoveryRef.current?.contextKey === contextKey
      ? recoveryRef.current
      : null;
    const promise = existing?.promise ?? recoverLegacyCloudGroupTitleNotices({
      messageIndex,
    });
    if (!existing) {
      const recovery = { contextKey, promise };
      recoveryRef.current = recovery;
      void promise.then(
        () => {
          if (recoveryRef.current === recovery) recoveryRef.current = null;
        },
        () => {
          if (recoveryRef.current === recovery) recoveryRef.current = null;
        },
      );
    }
    void promise.then((delta) => {
      if (active) completedContextKeyRef.current = contextKey;
      if (!active || (delta.messages.length === 0 && delta.sessionRepairs.length === 0)) return;
      setCanonicalState((current) => {
        const next = applyLegacyCloudGroupTitleNoticeClassificationDelta(
          canonicalStateRef.current ?? current,
          delta,
        );
        canonicalStateRef.current = next;
        return next;
      });
    }).catch((error) => {
      reportWarningRef.current(
        '[cloud-group] failed to classify legacy title sync notices',
        error,
      );
    });
    return () => {
      active = false;
    };
  }, [
    canonicalStateRef,
    contextKey,
    enabled,
    messageIndex,
    setCanonicalState,
  ]);
}
