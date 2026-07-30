import type {
  CloudMessage,
} from './authClient';

export type CloudRealtimeMessageAction =
  | { kind: 'refresh' }
  | { kind: 'message'; message: CloudMessage }
  | null;

type CloudRealtimeMessagePayload = {
  message_id: string;
  from_account_id: string;
  to_account_id: string;
  body: string;
  created_at: string;
  delivered_at?: string | null;
  read_at?: string | null;
  session_id?: string | null;
};

export function decodeCloudRealtimeMessageFrame(
  data: unknown,
  accountId: string,
): CloudRealtimeMessageAction {
  const parsed: unknown = JSON.parse(
    typeof data === 'string' ? data : '',
  );
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as {
    subject?: string;
    payload?: CloudRealtimeMessagePayload;
  };
  const subject = frame.subject;
  if (subject?.startsWith('kordi.events.message.read.')) {
    return { kind: 'refresh' };
  }
  if (!subject?.startsWith('kordi.events.message.arrived.')) {
    return null;
  }
  const payload = frame.payload;
  if (!payload || typeof payload !== 'object') return null;
  const from = payload.from_account_id;
  const to = payload.to_account_id;
  if (!from || !to) return null;
  return {
    kind: 'message',
    message: {
      messageId: payload.message_id,
      fromAccountId: from,
      toAccountId: to,
      body: payload.body,
      createdAt: payload.created_at,
      deliveredAt:
        payload.delivered_at ?? payload.created_at ?? null,
      readAt: payload.read_at ?? null,
      direction: to === accountId ? 'incoming' : 'outgoing',
      sessionId:
        typeof payload.session_id === 'string'
          ? payload.session_id
          : null,
    },
  };
}
