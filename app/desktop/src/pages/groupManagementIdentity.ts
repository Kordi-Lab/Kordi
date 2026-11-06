import { adminIdentityIdsFromMetadata } from '@/features/chat/chatCreateFlows';
import type { Contact, ConversationParticipant, ParticipantSpaceViewModel } from '@/kordi-app/types';

/** Identity matching and labels for group Info's member gallery. */

export function isHumanMember(participant: ConversationParticipant) {
  return participant.kind === 'human';
}

export function isSelfMember(participant: ConversationParticipant) {
  return participant.role === 'self' || (participant.kind === 'human' && participant.source === 'local');
}

function fallbackRoleAdminIds(members: ConversationParticipant[]) {
  return members.filter((member) => member.role === 'admin').map((member) => member.id);
}

export function groupAdminIds(space: ParticipantSpaceViewModel | null, members: ConversationParticipant[]) {
  const activeSession = space?.sessions[0] ?? null;
  if (space?.groupAdminIdentityIds?.length) {
    return new Set(space.groupAdminIdentityIds.map((id) => id.trim()).filter(Boolean));
  }
  const metadataAdminIds = adminIdentityIdsFromMetadata(activeSession?.conversation.metadata);
  const uniqueMetadataAdminIds = [...new Set(metadataAdminIds.map((id) => id.trim()).filter(Boolean))];
  const creatorId = space?.groupCreatorIdentityId?.trim()
    || activeSession?.conversation.canonicalCreatedByIdentityId?.trim()
    || '';
  if (uniqueMetadataAdminIds.length > 0) return new Set([creatorId, ...uniqueMetadataAdminIds].filter(Boolean));
  const roleAdminIds = fallbackRoleAdminIds(members);
  if (roleAdminIds.length > 0) return new Set([creatorId, ...roleAdminIds].filter(Boolean));
  return new Set(creatorId ? [creatorId] : []);
}

export function memberStableId(member: ConversationParticipant) {
  return member.humanId?.trim()
    || member.sourceIdentityId?.trim()
    || member.id.trim();
}

function identityKeyVariants(value?: string | null) {
  const key = value?.trim() ?? '';
  if (!key) return [];
  return key.startsWith('human:')
    ? [key, key.slice('human:'.length)]
    : [key, `human:${key}`];
}

function memberIdentityKeys(member: ConversationParticipant, currentAccountId?: string | null) {
  return new Set([
    ...identityKeyVariants(member.id),
    ...identityKeyVariants(memberStableId(member)),
    ...identityKeyVariants(member.humanId),
    ...identityKeyVariants(member.sourceIdentityId),
    ...(isSelfMember(member) ? identityKeyVariants(currentAccountId) : []),
  ]);
}

export function memberIsAdmin(member: ConversationParticipant, adminIds: Set<string>, currentAccountId?: string | null) {
  const keys = memberIdentityKeys(member, currentAccountId);
  return [...adminIds].some((adminId) => identityKeyVariants(adminId).some((key) => keys.has(key)));
}

export function memberMatchesIdentity(member: ConversationParticipant, identityId?: string | null, currentAccountId?: string | null) {
  const keys = memberIdentityKeys(member, currentAccountId);
  return identityKeyVariants(identityId).some((key) => keys.has(key));
}

export function contactStableId(contact: Contact) {
  return contact.sourceHumanId?.trim()
    || contact.sourceParticipantId?.trim()
    || (contact.id.startsWith('cloud:') ? contact.id.slice('cloud:'.length).trim() : '')
    || contact.id.trim();
}

function isOpaqueIdentityLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('acct_')
    || normalized.startsWith('human:acct_')
    || normalized.startsWith('cloud:acct_');
}

export function visibleIdentityLabel(value: string) {
  const normalized = value.trim();
  return normalized && !isOpaqueIdentityLabel(normalized) ? normalized : '';
}

export function duplicateNameCounts(names: string[]) {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function hasDuplicateName(name: string, counts: Map<string, number>) {
  return (counts.get(name.trim().toLowerCase()) ?? 0) > 1;
}

export function groupActionErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'The group could not be updated. Try again.';
}
