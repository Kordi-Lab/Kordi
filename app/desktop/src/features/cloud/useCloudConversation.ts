// useCloudConversation: messages + send + live WS push for a single
// cloud peer pair. Owns the chat surface's state for one
// peerAccountId. Multi-peer / inbox-aggregation is layered on top
// of this hook by callers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CloudAuthClient,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
} from './authClient';
import { cloudMessageAttachmentToMessageAttachment, uploadCloudFiles } from './cloudAttachments';
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

function mergeCloudConversationAttachments(
  current: CloudMessage['attachments'],
  incoming: CloudMessage['attachments'],
): CloudMessage['attachments'] {
  if (incoming === undefined) return current;
  const currentById = new Map((current ?? []).map((attachment) => [attachment.attachmentId, attachment]));
  return incoming.map((attachment) => {
    const previous = currentById.get(attachment.attachmentId);
    return {
      ...previous,
      ...attachment,
      localPath: attachment.localPath ?? previous?.localPath ?? null,
    };
  });
}

export function mergeCloudConversationSnapshot(
  current: readonly CloudMessage[],
  incoming: readonly CloudMessage[],
): CloudMessage[] {
  const byMessageId = new Map(current.map((message) => [message.messageId, message]));
  for (const message of incoming) {
    const previous = byMessageId.get(message.messageId);
    byMessageId.set(message.messageId, previous
      ? {
          ...previous,
          ...message,
          attachments: mergeCloudConversationAttachments(previous.attachments, message.attachments),
        }
      : message);
  }
  return [...byMessageId.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.messageId.localeCompare(right.messageId)
  ));
}

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
  const conversationKey = account && peerAccountId ? `${account.accountId}\u001f${peerAccountId}` : '';
  const conversationKeyRef = useRef(conversationKey);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    conversationKeyRef.current = conversationKey;
    setMessages([]);
    setLoading(false);
    setError(null);
  }, [conversationKey]);

  // Merge an incoming message into the list, dedupe by messageId,
  // and keep the list sorted by created_at.
  const mergeMessage = useCallback((msg: CloudMessage) => {
    setMessages((previous) => mergeCloudConversationSnapshot(previous, [msg]));
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!account || !peerAccountId) {
      setMessages([]);
      return;
    }
    const requestConversationKey = conversationKey;
    const session = await loadSession();
    if (!session?.token || conversationKeyRef.current !== requestConversationKey) return;
    setLoading(true);
    setError(null);
    try {
      const list = await client.listMessages(session.token, peerAccountId);
      const resolvedList = list.map((message) => ({
        ...message,
        attachments: message.attachments?.length
          ? message.attachments.map(cloudMessageAttachmentToMessageAttachment)
          : [],
      }));
      if (cancelledRef.current || conversationKeyRef.current !== requestConversationKey) return;
      setMessages((current) => mergeCloudConversationSnapshot(current, resolvedList));
    } catch (err) {
      if (cancelledRef.current || conversationKeyRef.current !== requestConversationKey) return;
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      if (!cancelledRef.current && conversationKeyRef.current === requestConversationKey) setLoading(false);
    }
  }, [account, peerAccountId, client, conversationKey]);

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
    if (!account || !peerAccountId || !cloudRealtimeWebSocketEnabled()) return;
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
          const attachments = Array.isArray(payload.attachments)
            ? payload.attachments.map(cloudMessageAttachmentToMessageAttachment)
            : [];
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
            sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
          });
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
        const uploadedAttachments = attachments.length > 0
          ? await uploadCloudFiles({ token: session.token, client, files: attachments })
          : [];
        const sendAttachments = uploadedAttachments.map((attachment) => ({
          attachmentId: attachment.attachmentId,
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }));
        const msg = await client.sendMessage(session.token, peerAccountId, trimmed, { attachments: sendAttachments });
        const attachmentsById = new Map(uploadedAttachments.map((attachment) => [attachment.attachmentId, attachment]));
        mergeMessage({
          ...msg,
          attachments: msg.attachments?.length
            ? msg.attachments.map((attachment) => ({ ...attachment, localPath: attachmentsById.get(attachment.attachmentId)?.localPath ?? attachment.localPath ?? null }))
            : uploadedAttachments,
        });
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
