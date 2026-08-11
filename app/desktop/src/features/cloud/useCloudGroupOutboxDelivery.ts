import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  updateCanonicalMessageDelivery,
} from '@/lib/desktop';
import {
  mergeCanonicalMessageDeliveryDelta,
} from '@/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  uploadComposerAttachments,
} from './cloudAttachments';
import {
  CloudGroupOutbox,
  cloudGroupOutboxDeliveryStatus,
  cloudGroupOutboxNextWakeAtMs,
  type CloudGroupOutboxEntry,
} from './cloudGroupOutbox';
import {
  prepareCloudGroupOutboxEntryAttachments,
} from './cloudGroupOutboxAttachments';
import type {
  CloudMessageSyncController,
} from './useCloudMessageSync';
import {
  loadSession,
} from './session';

type SyncCloudCollaborationDiff =
  CloudMessageSyncController['syncCloudCollaborationDiff'];

export function useCloudGroupOutboxDelivery({
  account,
  canonicalStateReady,
  canonicalStateRef,
  setCanonicalState,
  client,
  outbox,
  mergeMessage,
  syncCloudCollaborationDiff,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalStateReady: boolean;
  canonicalStateRef: MutableRefObject<
    CanonicalSessionState | null
  >;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  client: CloudAuthClient;
  outbox: CloudGroupOutbox | null;
  mergeMessage: (message: CloudMessage) => void;
  syncCloudCollaborationDiff: SyncCloudCollaborationDiff;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const mergeMessageRef = useRef(mergeMessage);
  const syncCloudCollaborationDiffRef = useRef(
    syncCloudCollaborationDiff,
  );

  useEffect(() => {
    mergeMessageRef.current = mergeMessage;
  }, [mergeMessage]);

  useEffect(() => {
    syncCloudCollaborationDiffRef.current =
      syncCloudCollaborationDiff;
  }, [syncCloudCollaborationDiff]);

  const persistCloudGroupOutboxDelivery = useCallback(
    async (entry: CloudGroupOutboxEntry) => {
      if (entry.trackCanonicalDelivery === false) {
        await outbox?.acknowledgeCanonicalDelivery(
          entry.canonicalMessageId,
        );
        return;
      }
      const delivery = cloudGroupOutboxDeliveryStatus(entry);
      const delta = await updateCanonicalMessageDelivery({
        messageId: entry.canonicalMessageId,
        sessionId: entry.sessionId,
        ...delivery,
      });
      if (!delta) return;
      canonicalStateRef.current =
        mergeCanonicalMessageDeliveryDelta(
          canonicalStateRef.current,
          delta,
        );
      setCanonicalState?.((current) =>
        mergeCanonicalMessageDeliveryDelta(current, delta)
      );
      await outbox?.acknowledgeCanonicalDelivery(
        entry.canonicalMessageId,
      );
    },
    [canonicalStateRef, outbox, setCanonicalState],
  );

  useEffect(() => {
    if (
      !account
      || !outbox
      || !canonicalStateReady
      || typeof window === 'undefined'
    ) return undefined;
    let cancelled = false;
    let draining = false;
    let retryTimer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      const nowMs = Date.now();
      const nextWakeAtMs = cloudGroupOutboxNextWakeAtMs(
        outbox.entries(),
        nowMs,
      );
      if (nextWakeAtMs === null) return;
      retryTimer = window.setTimeout(
        () => {
          void drain();
        },
        Math.max(0, nextWakeAtMs - nowMs),
      );
    };

    const drain = async () => {
      if (cancelled || draining) return;
      draining = true;
      let sentAny = false;
      const sessionPromise = loadSession();
      try {
        const preparedEntries = new Map<
          string,
          Promise<CloudGroupOutboxEntry>
        >();
        const outcomes = await outbox.deliverDue(
          async ({ recipientId, clientMessageId, entry }) => {
            const session = await sessionPromise;
            if (!session?.token) throw new Error('Not signed in.');
            let preparedEntry = preparedEntries.get(
              entry.canonicalMessageId,
            );
            if (!preparedEntry) {
              preparedEntry =
                prepareCloudGroupOutboxEntryAttachments({
                  outbox,
                  entry,
                  upload: (attachments) =>
                    uploadComposerAttachments({
                      token: session.token,
                      client,
                      attachments,
                    }),
                });
              preparedEntries.set(
                entry.canonicalMessageId,
                preparedEntry,
              );
            }
            const ready = await preparedEntry;
            const memberAccountIds = [...new Set([
              ...ready.pendingRecipientIds,
              ...ready.deliveredRecipientIds,
              ...(ready.exhaustedRecipientIds ?? []),
            ])];
            const message = await client.sendMessage(
              session.token,
              recipientId,
              ready.envelope,
              {
                sessionId: ready.sessionId,
                attachments: ready.attachments,
                clientCreatedAt: ready.clientCreatedAt,
                clientMessageId,
                conversationKind: 'group',
                memberAccountIds,
              },
            );
            sentAny = true;
            mergeMessageRef.current(message);
          },
        );
        for (const outcome of outcomes) {
          if (outcome) {
            await persistCloudGroupOutboxDelivery(outcome);
          }
        }
        if (sentAny) {
          await syncCloudCollaborationDiffRef.current();
        }
      } catch (error) {
        // Keep persisted recipients queued; lifecycle events resume them.
        reportWarning('[cloud-group-outbox] retry failed', error);
      } finally {
        draining = false;
        scheduleNext();
      }
    };

    const resume = () => {
      void drain();
    };
    const resumeWhenVisible = () => {
      if (
        typeof document === 'undefined'
        || document.visibilityState === 'visible'
      ) resume();
    };
    const unsubscribe = outbox.subscribe(scheduleNext);
    void outbox.restore()
      .then(async (entries) => {
        for (const entry of entries) {
          await persistCloudGroupOutboxDelivery(entry)
            .catch(() => {});
        }
        await drain();
      })
      .catch((error) => {
        reportWarning('[cloud-group-outbox] restore failed', error);
      });
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener(
      'visibilitychange',
      resumeWhenVisible,
    );
    return () => {
      cancelled = true;
      unsubscribe();
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener(
        'visibilitychange',
        resumeWhenVisible,
      );
    };
  }, [
    account,
    canonicalStateReady,
    client,
    outbox,
    persistCloudGroupOutboxDelivery,
    reportWarning,
  ]);

  return persistCloudGroupOutboxDelivery;
}
