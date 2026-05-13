// useCloudConversation: messages + send + live WS push for a single
// cloud peer pair. Owns the chat surface's state for one
// peerAccountId. Multi-peer / inbox-aggregation is layered on top
// of this hook by callers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CloudAuthClient,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
} from './authClient';
import { resolveCloudMessageAttachments } from './cloudAttachments';
import { loadSession } from './session';

const POLL_FALLBACK_MS = 20_000;

export type UseCloudConversationResult = {
  messages: CloudMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  send(body: string, attachments?: File[]): Promise<void>;
  refresh(): Promise<void>;
};

export function useCloudConversation(
  account: CloudAccount | null,
  peerAccountId: string | null,
): UseCloudConversationResult {
  const client = useMemo<CloudAuthClient>(() => defaultCloudAuthClient(), []);
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Merge an incoming message into the list, dedupe by messageId,
  // and keep the list sorted by created_at.
  const mergeMessage = useCallback((msg: CloudMessage) => {
    setMessages((prev) => {
      if (prev.some((existing) => existing.messageId === msg.messageId)) {
        return prev;
      }
      const next = [...prev, msg];
      next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return next;
    });
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!account || !peerAccountId) {
      setMessages([]);
      return;
    }
    const session = await loadSession();
    tokenRef.current = session?.token ?? null;
    if (!session?.token) return;
    setLoading(true);
    setError(null);
    try {
      const list = await client.listMessages(session.token, peerAccountId);
      const resolvedList = await Promise.all(list.map(async (message) => ({
        ...message,
        attachments: message.attachments?.length
          ? await resolveCloudMessageAttachments({ token: session.token, client, attachments: message.attachments })
          : [],
      })));
      if (cancelledRef.current) return;
      setMessages(resolvedList);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [account, peerAccountId, client]);

  // Initial fetch + safety-net poll fallback (in case the WS drops).
  useEffect(() => {
    if (!account || !peerAccountId) {
      setMessages([]);
      return;
    }
    void fetchMessages();
    const interval = window.setInterval(() => void fetchMessages(), POLL_FALLBACK_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [account, peerAccountId, fetchMessages]);

  // WebSocket subscription for live push of kordi.events.message.arrived.<self>.
  // Filter to messages whose other party is the active peer.
  useEffect(() => {
    if (!account || !peerAccountId) return;
    let ws: WebSocket | null = null;
    let cancelled = false;

    const open = async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      ws = new WebSocket(cloudWebSocketUrl(session.token));
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
          const subject: string | undefined = frame?.subject;
          if (!subject?.startsWith('kordi.events.message.arrived.')) return;
          const payload = frame?.payload;
          if (!payload || typeof payload !== 'object') return;
          const from = payload.from_account_id as string | undefined;
          const to = payload.to_account_id as string | undefined;
          if (!from || !to) return;
          // Only messages in *this* conversation
          if (from !== peerAccountId && to !== peerAccountId) return;
          const direction = to === account.accountId ? 'incoming' : 'outgoing';
          void (async () => {
            const session = await loadSession();
            const attachments = Array.isArray(payload.attachments) && session?.token
              ? await resolveCloudMessageAttachments({ token: session.token, client, attachments: payload.attachments })
              : Array.isArray(payload.attachments) ? payload.attachments : [];
            mergeMessage({
              messageId: payload.message_id,
              fromAccountId: from,
              toAccountId: to,
              body: payload.body,
              createdAt: payload.created_at,
              deliveredAt: null,
              readAt: null,
              direction,
              attachments,
            });
          })();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[cloud-ws] frame parse failed', err);
        }
      };
      ws.onerror = (event) => {
        // eslint-disable-next-line no-console
        console.warn('[cloud-ws] error', event);
      };
    };
    void open();

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [account, peerAccountId, mergeMessage]);

  const send = useCallback(
    async (body: string, attachments: File[] = []) => {
      const trimmed = body.trim();
      if ((!trimmed && attachments.length === 0) || !account || !peerAccountId) return;
      const session = await loadSession();
      if (!session?.token) {
        setError('Not signed in.');
        return;
      }
      setSending(true);
      setError(null);
      try {
        const uploadedAttachments = [];
        for (const file of attachments) {
          const uploaded = await client.uploadAttachment(session.token, file);
          uploadedAttachments.push({
            attachmentId: uploaded.attachmentId,
            name: file.name || 'attachment',
            kind: file.type.startsWith('image/') ? 'image' as const : 'file' as const,
            mimeType: file.type || null,
            sizeBytes: file.size,
          });
        }
        const msg = await client.sendMessage(session.token, peerAccountId, trimmed, { attachments: uploadedAttachments });
        mergeMessage(msg);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send');
      } finally {
        setSending(false);
      }
    },
    [account, peerAccountId, client, mergeMessage],
  );

  return { messages, loading, sending, error, send, refresh: fetchMessages };
}
