import type { CloudMessage } from './authClient';

const cleanText = (value?: string | null) => (value ?? '').trim();

export function cloudMessageRevision(messages: readonly CloudMessage[]): string {
  if (messages.length === 0) return '0::';
  let newest = messages[0];
  let newestTimestamp = cleanText(newest.readAt) || cleanText(newest.deliveredAt) || cleanText(newest.createdAt);
  let fingerprint = 2_166_136_261;
  const addFingerprintValue = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      fingerprint ^= value.charCodeAt(index);
      fingerprint = Math.imul(fingerprint, 16_777_619);
    }
  };
  for (const message of messages) {
    const effectiveTimestamp = cleanText(message.readAt) || cleanText(message.deliveredAt) || cleanText(message.createdAt);
    if (effectiveTimestamp > newestTimestamp || (effectiveTimestamp === newestTimestamp && message.messageId > newest.messageId)) {
      newest = message;
      newestTimestamp = effectiveTimestamp;
    }
    addFingerprintValue(message.messageId);
    addFingerprintValue(message.createdAt);
    addFingerprintValue(message.deliveredAt ?? '');
    addFingerprintValue(message.readAt ?? '');
    for (const accountId of message.readByAccountIds ?? []) addFingerprintValue(accountId);
    addFingerprintValue(message.sessionId ?? '');
    addFingerprintValue(message.messageKind ?? '');
    addFingerprintValue(String(message.version ?? ''));
    addFingerprintValue(String(message.body.length));
    for (const reaction of message.reactions ?? []) {
      addFingerprintValue(reaction.value);
      for (const accountId of reaction.accountIds) addFingerprintValue(accountId);
    }
    for (const attachment of message.attachments ?? []) {
      addFingerprintValue(attachment.attachmentId);
      addFingerprintValue(attachment.downloadUrl ?? '');
      addFingerprintValue(attachment.localPath ?? '');
    }
  }
  return [messages.length, newest.messageId, newestTimestamp, fingerprint >>> 0].join(':');
}
