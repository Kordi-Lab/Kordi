import {
  useEffect,
  useRef,
} from 'react';
import {
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  type CloudAccount,
  type CloudMessage,
} from './authClient';
import {
  CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
} from './useCloudContacts';
import {
  decodeCloudRealtimeMessageFrame,
} from './cloudRealtimeMessages';
import type {
  CloudMessageSyncController,
} from './useCloudMessageSync';
import {
  loadSession,
} from './session';

type SyncCloudCollaborationDiff =
  CloudMessageSyncController['syncCloudCollaborationDiff'];

export function useCloudRealtimeMessages({
  account,
  mergeMessage,
  syncCloudCollaborationDiff,
  reportWarning,
}: {
  account: CloudAccount | null;
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

  useEffect(() => {
    if (!account || typeof window === 'undefined') {
      return undefined;
    }
    const handleAcceptedContact = (event: Event) => {
      const detail =
        event instanceof CustomEvent
        && event.detail
        && typeof event.detail === 'object'
          ? event.detail as { message?: CloudMessage }
          : null;
      if (detail?.message) {
        mergeMessageRef.current(detail.message);
      }
    };
    window.addEventListener(
      CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
      handleAcceptedContact,
    );
    return () => {
      window.removeEventListener(
        CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
        handleAcceptedContact,
      );
    };
  }, [account]);

  useEffect(() => {
    if (!account) return;
    // Pin the socket to the account lifetime. Canonical state updates
    // frequently change callback identities; refs keep the socket stable.
    if (!cloudRealtimeWebSocketEnabled()) return;
    let ws: WebSocket | null = null;
    let cancelled = false;
    const accountIdAtOpen = account.accountId;

    const open = async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      ws = new WebSocket(cloudWebSocketUrl(session.token));
      ws.onmessage = (event) => {
        try {
          const action = decodeCloudRealtimeMessageFrame(
            event.data,
            accountIdAtOpen,
          );
          if (!action) return;
          if (action.kind === 'message') {
            mergeMessageRef.current(action.message);
          }
          void syncCloudCollaborationDiffRef.current();
        } catch (error) {
          reportWarning(
            '[cloud-collaboration-ws] frame parse failed',
            error,
          );
        }
      };
    };
    void open();
    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [account, reportWarning]);
}
