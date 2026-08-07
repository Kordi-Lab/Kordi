import {
  useEffect,
  useRef,
  useState,
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
import type {
  CloudAuthClient,
  CloudMessageBodyLookup,
} from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { loadSession } from './session';

const CLOUD_MESSAGE_BODY_LOOKUP_CHUNK_SIZE = 500;
const CLOUD_MESSAGE_BODY_LOOKUP_MAX_PARALLEL = 4;
const CLOUD_MESSAGE_BODY_LOOKUP_RETRY_DELAY_MS = 5_000;

type LegacyCloudGroupTitleNoticeRecoveryResult = {
  delta: LegacyCloudGroupTitleNoticeClassificationDelta;
  shouldRetry: boolean;
};

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
  client,
  messageIndex,
  reportWarning,
}: {
  client: CloudAuthClient;
  messageIndex: CloudMessageIndex;
  reportWarning: (message: string, error: unknown) => void;
}): Promise<LegacyCloudGroupTitleNoticeRecoveryResult> {
  const candidateMessageIds = await listLegacyCloudGroupTitleNoticeIds();
  if (candidateMessageIds.length === 0) {
    return {
      delta: { messages: [], sessionRepairs: [] },
      shouldRetry: false,
    };
  }
  const cachedMessages = candidateMessageIds.flatMap((messageId) => {
    const message = messageIndex.byMessageId.get(messageId);
    return message ? [message] : [];
  });
  const cachedMessageIds = new Set(cachedMessages.map((message) => message.messageId));
  const missingMessageIds = candidateMessageIds.filter((messageId) => !cachedMessageIds.has(messageId));
  const recoveredMessages: CloudMessageBodyLookup[] = [];
  let shouldRetry = false;
  if (missingMessageIds.length > 0) {
    const session = await loadSession();
    if (session?.token) {
      const chunks = Array.from(
        { length: Math.ceil(missingMessageIds.length / CLOUD_MESSAGE_BODY_LOOKUP_CHUNK_SIZE) },
        (_, index) => missingMessageIds.slice(
          index * CLOUD_MESSAGE_BODY_LOOKUP_CHUNK_SIZE,
          (index + 1) * CLOUD_MESSAGE_BODY_LOOKUP_CHUNK_SIZE,
        ),
      );
      for (let index = 0; index < chunks.length; index += CLOUD_MESSAGE_BODY_LOOKUP_MAX_PARALLEL) {
        const batch = await Promise.all(
          chunks
            .slice(index, index + CLOUD_MESSAGE_BODY_LOOKUP_MAX_PARALLEL)
            .map((messageIds) => client.lookupMessageBodies(session.token, messageIds).catch((error) => {
              shouldRetry = true;
              reportWarning(
                '[cloud-group] failed to recover historical control metadata',
                error,
              );
              return [];
            })),
        );
        recoveredMessages.push(...batch.flat());
      }
    } else {
      shouldRetry = true;
    }
  }
  const classifications = legacyCloudGroupTitleNoticeClassifications(
    candidateMessageIds,
    [...cachedMessages, ...recoveredMessages],
  );
  return {
    delta: await classifyLegacyCloudGroupTitleNotices(classifications),
    shouldRetry,
  };
}

export function useLegacyCloudGroupTitleNoticeRecovery({
  enabled,
  contextKey,
  client,
  canonicalStateRef,
  setCanonicalState,
  messageIndex,
  reportWarning,
}: {
  enabled: boolean;
  contextKey: string | null;
  client: CloudAuthClient;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  messageIndex: CloudMessageIndex;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const [retryVersion, setRetryVersion] = useState(0);
  const reportWarningRef = useRef(reportWarning);
  const completedContextKeyRef = useRef<string | null>(null);
  const recoveryRef = useRef<{
    contextKey: string;
    promise: Promise<LegacyCloudGroupTitleNoticeRecoveryResult>;
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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = () => {
      if (!active || retryTimer) return;
      retryTimer = setTimeout(() => {
        if (active) setRetryVersion((current) => current + 1);
      }, CLOUD_MESSAGE_BODY_LOOKUP_RETRY_DELAY_MS);
    };
    const existing = recoveryRef.current?.contextKey === contextKey
      ? recoveryRef.current
      : null;
    const promise = existing?.promise ?? recoverLegacyCloudGroupTitleNotices({
      client,
      messageIndex,
      reportWarning: (message, error) => reportWarningRef.current(message, error),
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
    void promise.then(({ delta, shouldRetry }) => {
      if (active && shouldRetry) scheduleRetry();
      if (active && !shouldRetry) completedContextKeyRef.current = contextKey;
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
      scheduleRetry();
    });
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    canonicalStateRef,
    client,
    contextKey,
    enabled,
    messageIndex,
    retryVersion,
    setCanonicalState,
  ]);
}
