import {
  useEffect,
  useRef,
} from 'react';
import {
  chatSyncWebSocketUrl,
  cloudRealtimeWebSocketEnabled,
  type CloudAccount,
  type CloudAuthClient,
  type CloudMessage,
} from './authClient';
import {
  CLOUD_CONTACT_ACCEPTED_SYNC_EVENT,
} from './useCloudContacts';
import type {
  CloudMessageSyncController,
} from './useCloudMessageSync';
import {
  loadSession,
} from './session';
import { loadChatSyncLocalState } from '@/lib/desktopChatSync';

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
  client,
  mergeMessage,
  syncCloudCollaborationDiff,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
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
    let heartbeatTimer: number | null = null;
    let heartbeatDeadlineTimer: number | null = null;
    let initialHeartbeatTimer: number | null = null;
    let heartbeatAwaitingAck = false;
    let lastAppliedSeq = 0;
    const accountIdAtOpen = account.accountId;

    const clearHeartbeatTimers = () => {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (heartbeatDeadlineTimer !== null) window.clearTimeout(heartbeatDeadlineTimer);
      if (initialHeartbeatTimer !== null) window.clearTimeout(initialHeartbeatTimer);
      heartbeatTimer = null;
      heartbeatDeadlineTimer = null;
      initialHeartbeatTimer = null;
      heartbeatAwaitingAck = false;
    };

    const sendHeartbeat = (socket: WebSocket) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (heartbeatAwaitingAck) {
        socket.close();
        return;
      }
      heartbeatAwaitingAck = true;
      socket.send(JSON.stringify({
        type: 'heartbeat',
        last_applied_seq: lastAppliedSeq,
      }));
      heartbeatDeadlineTimer = window.setTimeout(() => socket.close(), 45_000);
    };

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
        await syncCloudCollaborationDiffRef.current();
        const local = await loadChatSyncLocalState(accountIdAtOpen);
        if (!local?.cursor || cancelled) {
          throw new Error('Reliable chat cursor is unavailable after bootstrap.');
        }
        lastAppliedSeq = local.lastStreamSeq;
        const realtime = await client.issueChatSyncRealtimeTicket(session.token);
        if (cancelled) return;
        const socket = new WebSocket(chatSyncWebSocketUrl(realtime.ticket));
        ws = socket;
        socket.onopen = () => {
          reconnectAttempt = 0;
          socket.send(JSON.stringify({
            type: 'connect',
            protocol_version: 2,
            device_id: realtime.device_id,
            cursor: local.cursor,
          }));
        };
        socket.onmessage = (event) => {
          try {
            const frame = JSON.parse(typeof event.data === 'string' ? event.data : '') as {
              type?: string;
              stream_seq?: number;
              heartbeat_interval_ms?: number;
            };
            if (frame.type === 'hello') {
              const interval = Math.max(5_000, frame.heartbeat_interval_ms ?? 30_000);
              clearHeartbeatTimers();
              heartbeatTimer = window.setInterval(() => sendHeartbeat(socket), interval);
              initialHeartbeatTimer = window.setTimeout(
                () => sendHeartbeat(socket),
                Math.floor(Math.random() * interval),
              );
              return;
            }
            if (frame.type === 'heartbeat_ack') {
              if (heartbeatDeadlineTimer !== null) window.clearTimeout(heartbeatDeadlineTimer);
              heartbeatDeadlineTimer = null;
              heartbeatAwaitingAck = false;
              return;
            }
            if (frame.type === 'resync_required') {
              void syncCloudCollaborationDiffRef.current().finally(() => socket.close());
              return;
            }
            if (frame.type !== 'event' || typeof frame.stream_seq !== 'number') return;
            void syncCloudCollaborationDiffRef.current()
              .then(async () => {
                const applied = await loadChatSyncLocalState(accountIdAtOpen);
                if (applied) lastAppliedSeq = applied.lastStreamSeq;
              })
              .catch(() => socket.close());
          } catch (error) {
            reportWarning(
              '[cloud-collaboration-ws] frame parse failed',
              error,
            );
          }
        };
        socket.onclose = () => {
          if (ws === socket) ws = null;
          clearHeartbeatTimers();
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
      clearHeartbeatTimers();
      ws?.close();
    };
  }, [account, client, reportWarning]);
}
