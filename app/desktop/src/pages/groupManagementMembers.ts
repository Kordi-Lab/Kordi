import type { ConversationParticipant } from '@/kordi-app/types';

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
