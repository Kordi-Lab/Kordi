import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  incomingSessionTitleWins,
  isGenericSessionTitle,
  titleSourceFromMetadata,
} from '@/features/chat/sessionTitlePolicy';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import type { CloudSessionTitlesById } from './cloudDiffSync';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from './cloudAgentMessages';
import { loadSession } from './session';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function reserveCloudSessionTitleUpload(
  reservations: Map<string, string>,
  sessionId: string,
  signature: string,
): boolean {
  if (reservations.get(sessionId) === signature) return false;
  reservations.set(sessionId, signature);
  return true;
}

export function releaseCloudSessionTitleUpload(
  reservations: Map<string, string>,
  sessionId: string,
  signature: string,
): void {
  if (reservations.get(sessionId) === signature) {
    reservations.delete(sessionId);
  }
}

export function useCloudSelfAgentMetadataSync({
  account,
  canonicalState,
  client,
  initialMessagesSettled,
  messagesByPeer,
  setForksBySessionId,
  titlesBySessionId,
  setTitlesBySessionId,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null | undefined;
  client: CloudAuthClient;
  initialMessagesSettled: boolean;
  messagesByPeer: Record<string, CloudMessage[]>;
  setForksBySessionId: Dispatch<
    SetStateAction<Record<string, CloudSessionForkSummary>>
  >;
  titlesBySessionId: CloudSessionTitlesById;
  setTitlesBySessionId: Dispatch<
    SetStateAction<CloudSessionTitlesById>
  >;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const forkRefreshKeyRef = useRef<string | null>(null);
  const titleUploadsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    forkRefreshKeyRef.current = null;
    titleUploadsRef.current.clear();
  }, [account?.accountId]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const selfSessionIds = [
      ...new Set(
        (messagesByPeer[account.accountId] ?? [])
          .map((message) => cleanText(message.sessionId))
          .filter(Boolean),
      ),
    ].sort();
    if (selfSessionIds.length === 0) return;
    const refreshKey =
      `${account.accountId}:${selfSessionIds.join('|')}`;
    if (forkRefreshKeyRef.current === refreshKey) return;
    forkRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token) return;
      const results = await Promise.allSettled(
        selfSessionIds.map((sessionId) =>
          client.listSessionForks(session.token, sessionId)
        ),
      );
      const forks = results.flatMap((result) => (
        result.status === 'fulfilled' ? result.value : []
      ));
      if (cancelled || forks.length === 0) return;
      setForksBySessionId((current) => {
        let changed = false;
        const next = { ...current };
        for (const fork of forks) {
          const existing = next[fork.forkSessionId];
          if (
            existing?.parentSessionId === fork.parentSessionId
            && existing?.parentMessageId === fork.parentMessageId
            && existing?.createdAt === fork.createdAt
          ) continue;
          next[fork.forkSessionId] = fork;
          changed = true;
        }
        return changed ? next : current;
      });
    })().catch((error) => {
      reportWarning(
        '[cloud-self-agent-sync] failed to refresh cloud fork lineage',
        error,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    client,
    initialMessagesSettled,
    messagesByPeer,
    reportWarning,
    setForksBySessionId,
  ]);

  useEffect(() => {
    if (!account || !canonicalState || !initialMessagesSettled) return;
    const titleUploads = titleUploadsRef.current;
    const cloudBackedSessionIds = new Set(
      [
        ...(messagesByPeer[account.accountId] ?? [])
          .map((message) => cleanText(message.sessionId))
          .filter(Boolean),
        ...client.knownChatSessionIds(account.accountId),
      ],
    );
    if (cloudBackedSessionIds.size === 0) return;

    const uploads = canonicalState.sessions.flatMap(
      (canonicalSession) => {
        if (!cloudBackedSessionIds.has(canonicalSession.id)) return [];
        if (!['self-agent', 'project'].includes(canonicalSession.kind)) {
          return [];
        }
        if (
          canonicalSession.id.startsWith(
            CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
          )
        ) return [];
        const metadata =
          canonicalSession.metadata
          && typeof canonicalSession.metadata === 'object'
          && !Array.isArray(canonicalSession.metadata)
            ? canonicalSession.metadata as Record<string, unknown>
            : {};
        const titleSource = titleSourceFromMetadata(
          metadata,
          canonicalSession.title,
        );
        if (
          titleSource === 'placeholder'
          || isGenericSessionTitle(canonicalSession.title)
        ) return [];
        const titleRevisionValue =
          typeof metadata.sessionTitleRevision === 'number'
            ? metadata.sessionTitleRevision
            : 1;
        const titleRevision = titleSource === 'auto'
          ? Math.max(1, Math.min(2, Math.floor(titleRevisionValue)))
          : Math.max(1, Math.floor(titleRevisionValue));
        const titlePolicyVersion =
          typeof metadata.sessionTitlePolicyVersion === 'number'
            ? Math.max(
                1,
                Math.floor(metadata.sessionTitlePolicyVersion),
              )
            : 1;
        const updatedAtMs =
          typeof metadata.sessionTitleUpdatedAtMs === 'number'
            ? metadata.sessionTitleUpdatedAtMs
            : canonicalSession.updatedAtMs;
        const titleGeneratedFromMessageId =
          typeof metadata.sessionTitleGeneratedFromMessageId
            === 'string'
            ? metadata.sessionTitleGeneratedFromMessageId.trim()
              || null
            : null;
        const updatedByAccountId =
          typeof metadata.sessionTitleUpdatedByAccountId === 'string'
            ? metadata.sessionTitleUpdatedByAccountId.trim() || null
            : null;
        const remote = titlesBySessionId[canonicalSession.id];
        if (remote) {
          const remoteWins = incomingSessionTitleWins(
            {
              titleSource,
              titleRevision,
              updatedAtMs,
              updatedByAccountId,
            },
            remote,
          );
          const identical =
            remote.title === canonicalSession.title
            && remote.titleSource === titleSource
            && remote.titleRevision === titleRevision
            && remote.titlePolicyVersion === titlePolicyVersion
            && remote.titleGeneratedFromMessageId
              === titleGeneratedFromMessageId;
          if (identical || remoteWins) return [];
        }
        const input = {
          title: canonicalSession.title.trim(),
          titleSource,
          titleRevision,
          titlePolicyVersion,
          titleGeneratedFromMessageId,
          updatedAtMs,
        };
        const signature = JSON.stringify(input);
        if (
          titleUploads.get(canonicalSession.id)
          === signature
        ) return [];
        return [{
          sessionId: canonicalSession.id,
          input,
          signature,
        }];
      },
    );
    if (uploads.length === 0) return;

    let cancelled = false;
    for (const upload of uploads) {
      reserveCloudSessionTitleUpload(
        titleUploads,
        upload.sessionId,
        upload.signature,
      );
    }
    void (async () => {
      const authSession = await loadSession();
      if (!authSession?.token) {
        for (const upload of uploads) {
          releaseCloudSessionTitleUpload(
            titleUploads,
            upload.sessionId,
            upload.signature,
          );
        }
        return;
      }
      const results = await Promise.allSettled(
        uploads.map(async (upload) => ({
          upload,
          sessionTitle: await client.updateCloudSessionTitle(
            authSession.token,
            upload.sessionId,
            upload.input,
          ),
        })),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') continue;
        const failedUpload = uploads[index];
        if (!failedUpload) continue;
        releaseCloudSessionTitleUpload(
          titleUploads,
          failedUpload.sessionId,
          failedUpload.signature,
        );
      }
      if (cancelled) return;
      setTitlesBySessionId((current) => {
        let next = current;
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const existing = next[result.value.sessionTitle.sessionId];
            if (
              existing
              && existing.title === result.value.sessionTitle.title
              && existing.titleSource
                === result.value.sessionTitle.titleSource
              && existing.titleRevision
                === result.value.sessionTitle.titleRevision
              && existing.titlePolicyVersion
                === result.value.sessionTitle.titlePolicyVersion
              && existing.titleGeneratedFromMessageId
                === result.value.sessionTitle.titleGeneratedFromMessageId
              && existing.updatedAtMs
                === result.value.sessionTitle.updatedAtMs
              && existing.updatedByAccountId
                === result.value.sessionTitle.updatedByAccountId
            ) continue;
            next = {
              ...next,
              [result.value.sessionTitle.sessionId]:
                result.value.sessionTitle,
            };
          }
        }
        return next;
      });
    })().catch(() => {
      for (const upload of uploads) {
        releaseCloudSessionTitleUpload(
          titleUploads,
          upload.sessionId,
          upload.signature,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    canonicalState,
    client,
    initialMessagesSettled,
    messagesByPeer,
    setTitlesBySessionId,
    titlesBySessionId,
  ]);

}
