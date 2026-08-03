import type { CloudMessage } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { parseCloudGroupControl } from './cloudGroupMessages';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function cloudGroupLocalAgentRequestAlreadyHandled(input: {
  localAccountId: string;
  requestMessageId: string;
  messages?: CloudMessage[];
  groupRows?: readonly IndexedCloudGroupRow[];
  ignoreFailedCloudFallback?: boolean;
}): boolean {
  const localAccountId = cleanText(input.localAccountId);
  const requestMessageId = cleanText(input.requestMessageId);
  if (!localAccountId || !requestMessageId) return false;
  const rows = input.groupRows ?? (input.messages ?? []).flatMap((wire) => {
    const envelope = parseCloudGroupControl(wire.body);
    return envelope ? [{ wire, envelope, canonicalMessageId: cleanText(envelope.message?.id) || null }] : [];
  });
  return rows.some(({ wire, envelope }) => {
    if (wire.fromAccountId !== localAccountId) return false;
    const groupMessage = envelope.kind === 'group-message' ? envelope.message : null;
    if (!groupMessage || groupMessage.senderAccountId !== localAccountId || groupMessage.senderKind !== 'agent') return false;
    if (
      input.ignoreFailedCloudFallback
      && groupMessage.deliveryState === 'failed'
      && groupMessage.id.startsWith('cloudrunmsg_')
    ) return false;
    const linkedRequestId = cleanText(groupMessage.requestId) || cleanText(groupMessage.replyToMessageId);
    return linkedRequestId === requestMessageId;
  });
}
