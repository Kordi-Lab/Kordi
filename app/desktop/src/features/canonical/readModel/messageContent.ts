import { canonicalIdentityAvatarSeed } from '@/features/canonical/avatarIdentity';
import type {
CanonicalIdentity,
Message
} from '@/kordi-app/types';

export function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function canonicalReadReceiptSummary(
  content: Record<string, unknown>,
  identityById: Map<string, CanonicalIdentity>,
): Message['readReceiptSummary'] {
  const summary = contentRecord(content.readReceiptSummary);
  const rawParticipants = Array.isArray(summary.participants) ? summary.participants : [];
  const participants = rawParticipants.flatMap((value) => {
    const record = contentRecord(value);
    const accountId = stringValue(record.accountId)?.trim() ?? '';
    const identityId = stringValue(record.identityId)?.trim() || (accountId ? `human:${accountId}` : '');
    if (!identityId) return [];
    const identity = identityById.get(identityId);
    const name = identity?.displayName || stringValue(record.name)?.trim() || accountId || 'Someone';
    return [{
      id: identity?.id ?? identityId,
      name,
      avatarSeed: canonicalIdentityAvatarSeed(identity) ?? stringValue(record.avatarSeed) ?? null,
      profileImageUrl: identity?.profileImageUrl ?? stringValue(record.profileImageUrl) ?? null,
      readAt: stringValue(record.readAt) ?? null,
    }];
  });
  const count = Math.max(0, Math.floor(numberValue(summary.count) ?? participants.length));
  if (count <= 0) return null;
  return { count, participants: participants.slice(0, Math.max(count, participants.length)) };
}
