// Membership and identity helpers for the group details dialog.
import { adminIdentityIdsFromMetadata } from '@/features/chat/chatCreateFlows';
import type {
  Contact, ConversationParticipant, ParticipantSpaceSessionViewModel, ParticipantSpaceViewModel,
} from '@/kordi-app/types';

export function isHumanMember(participant: ConversationParticipant) {
  return participant.kind === 'human';
}

export function isSelfMember(participant: ConversationParticipant) {
  return participant.role === 'self' || (participant.kind === 'human' && participant.source === 'local');
}

export function fallbackRoleAdminIds(members: ConversationParticipant[]) {
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

export function identityKeyVariants(value?: string | null) {
  const key = value?.trim() ?? '';
  if (!key) return [];
  return key.startsWith('human:')
    ? [key, key.slice('human:'.length)]
    : [key, `human:${key}`];
}

export function memberIdentityKeys(member: ConversationParticipant, currentAccountId?: string | null) {
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

export function isOpaqueIdentityLabel(value: string) {
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

export function normalizedSearch(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function filterGroupManagementMembers(
  members: ConversationParticipant[],
  query: string,
) {
  const needle = normalizedSearch(query);
  if (!needle) return members;
  return members.filter((member) => [
    member.name,
    member.id,
    member.humanId,
    member.sourceIdentityId,
  ].some((value) => value?.toLocaleLowerCase().includes(needle)));
}

export function groupActionErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'The group could not be updated. Try again.';
}

/** The session id AI access calls use for one channel of a group. */
export function aiAccessSessionId(session: ParticipantSpaceSessionViewModel): string {
  return session.canonicalSessionId ?? session.conversation.canonicalSessionId ?? session.id;
}

/**
 * The channel the AI access panel covers. Settings belong to each channel, so
 * it is the channel the person picked in the panel, else the one they have
 * open, else the group's first channel.
 */
export function aiAccessChannel(
  space: ParticipantSpaceViewModel | null,
  activeSessionId: string | null | undefined,
  pickedSessionId: string | null | undefined,
): ParticipantSpaceSessionViewModel | null {
  const sessions = space?.sessions ?? [];
  const find = (id: string | null | undefined) => (id
    ? sessions.find((session) => session.id === id || aiAccessSessionId(session) === id)
    : undefined);
  return find(pickedSessionId) ?? find(activeSessionId) ?? sessions[0] ?? null;
}
