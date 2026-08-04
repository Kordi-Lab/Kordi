import type { Contact } from '@/kordi-app/types';
import { KORDI_SUPPORT_AVATAR_URL } from '@/features/support/supportIdentity';

import type { CloudContactSummary } from './cloudContactTypes';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';

export const CLOUD_HOST_SENTINEL = 'cloud';

export function isCloudContact(contact: Contact): boolean {
  return contact.id.startsWith('cloud:')
    || contact.sourceHostId === CLOUD_HOST_SENTINEL
    || contact.discoverableOn.includes(CLOUD_HOST_SENTINEL);
}

export function cloudContactToContact(row: CloudContactSummary): Contact {
  const name = row.displayName ?? row.accountId;
  const isSystemAgent = row.contactKind === 'system_agent' && Boolean(row.targetCloudAgentId?.trim());
  const isSupportContact = isSystemAgent && Boolean(row.supportTicketEnabled);
  const classType = isSystemAgent && !isSupportContact ? 'other-users-agents' : 'other-users';
  const entityType = isSystemAgent && !isSupportContact ? 'agent' : 'user';
  const contactId = row.contactId?.trim();
  return {
    id: contactId ? `cloud-contact:${contactId}` : `cloud:${row.accountId}`,
    name,
    initials: cloudContactInitials(name),
    classType,
    entityType,
    subtitle: row.subtitle?.trim() || (isSystemAgent ? 'Official Kordi agent' : row.accountId),
    collaborationSources: [CLOUD_HOST_SENTINEL],
    status: 'online',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: isSystemAgent ? (row.subtitle?.trim() || 'Official Kordi support') : row.accountId,
    owner: row.targetCloudAgentOwnerName?.trim() || name,
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceParticipantId: row.accountId,
    sourceRuntime: isSystemAgent ? 'kordi-desktop' : 'person',
    sourceHumanId: row.accountId,
    sourceAgentId: isSystemAgent ? row.targetCloudAgentId?.trim() || null : null,
    contactStatus: 'accepted',
    contactRequestDirection: 'outgoing',
    avatarSeed: cloudAvatarSeedForAccount(row.accountId, row.avatarUrl),
    profileImageUrl: isSupportContact
      ? KORDI_SUPPORT_AVATAR_URL
      : cloudAvatarImageUrl(row.avatarUrl),
    systemContact: isSystemAgent,
    locked: Boolean(row.locked),
    supportTicketEnabled: Boolean(row.supportTicketEnabled),
    targetCloudAgentId: row.targetCloudAgentId?.trim() || null,
    targetCloudAgentName: row.targetCloudAgentName?.trim() || null,
    targetCloudAgentOwnerAccountId: row.targetCloudAgentOwnerAccountId?.trim() || null,
    targetCloudAgentOwnerName: row.targetCloudAgentOwnerName?.trim() || null,
  };
}

export function cloudContactInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
