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

export const CLOUD_REALTIME_RECONNECT_INITIAL_MS = 1_000;
export const CLOUD_REALTIME_RECONNECT_MAX_MS = 15_000;

export function cloudRealtimeReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    CLOUD_REALTIME_RECONNECT_INITIAL_MS * (2 ** safeAttempt),
    CLOUD_REALTIME_RECONNECT_MAX_MS,
  );
}

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
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    const accountIdAtOpen = account.accountId;

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const delay = cloudRealtimeReconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void open();
      }, delay);
    };

    const open = async () => {
      try {
        const session = await loadSession();
        if (!session?.token || cancelled) return;
        const socket = new WebSocket(cloudWebSocketUrl(session.token));
        ws = socket;
        socket.onopen = () => {
          reconnectAttempt = 0;
          void syncCloudCollaborationDiffRef.current();
        };
        socket.onmessage = (event) => {
          try {
            const action = decodeCloudRealtimeMessageFrame(
              event.data,
              accountIdAtOpen,
            );
            if (!action) return;
            void syncCloudCollaborationDiffRef.current();
          } catch (error) {
            reportWarning(
              '[cloud-collaboration-ws] frame parse failed',
              error,
            );
          }
        };
        socket.onclose = () => {
          if (ws === socket) ws = null;
          scheduleReconnect();
        };
        socket.onerror = () => {
          socket.close();
        };
      } catch (error) {
        if (!cancelled) {
          reportWarning(
            '[cloud-collaboration-ws] connection failed',
            error,
          );
          scheduleReconnect();
        }
      }
    };
    void open();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    };
  }, [account, reportWarning]);
}
