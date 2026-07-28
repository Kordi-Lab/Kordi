type CompatibilityRecord = Record<string, unknown>;

function stringField(record: CompatibilityRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function compatibleStringField(
  record: CompatibilityRecord,
  currentKey: string,
  legacyKey: string,
): string | undefined {
  return stringField(record, currentKey) ?? stringField(record, legacyKey);
}

export function compatibleSourceHostId(record: CompatibilityRecord): string | undefined {
  return compatibleStringField(record, 'sourceHostId', 'bridgeHostId');
}

export function compatibleSourceIdentityId(record: CompatibilityRecord): string | undefined {
  return compatibleStringField(record, 'sourceIdentityId', 'bridgeNodeId');
}

export function compatibleSourceConversationId(record: CompatibilityRecord): string | undefined {
  return compatibleStringField(record, 'sourceConversationId', 'bridgeConversationId');
}

export function compatibleSourceRequestId(record: CompatibilityRecord): string | undefined {
  return compatibleStringField(record, 'sourceRequestId', 'bridgeRequestId');
}

export function normalizeCollaborationTargetKind(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized === 'bridge-agent') return 'agent';
  if (normalized === 'bridge-person') return 'person';
  return normalized || undefined;
}

export function collaborationMessageSourceId(
  messageId: string,
  conversationId?: string,
): string | null {
  const prefixes = conversationId
    ? [
        `collaboration-message:${conversationId}:`,
        `bridge-message:${conversationId}:`,
      ]
    : ['collaboration-message:', 'bridge-message:'];
  const prefix = prefixes.find((candidate) => messageId.startsWith(candidate));
  if (!prefix) return null;
  if (conversationId) return messageId.slice(prefix.length).trim() || null;
  return messageId.split(':').filter(Boolean).pop()?.trim() || null;
}

export function isCollaborationLiveTurnId(messageId: string | null | undefined): boolean {
  return Boolean(
    messageId?.startsWith('collaboration-live-turn:')
    || messageId?.startsWith('bridge-live-turn:'),
  );
}

export function isCollaborationSelfContactId(contactId: string | null | undefined): boolean {
  return Boolean(
    contactId?.startsWith('collaboration-self:')
    || contactId?.startsWith('bridge-self:'),
  );
}
