export type CloudGroupParticipant = {
  accountId: string;
  kordiId?: string | null;
  displayName: string;
  avatarUrl: string | null;
  agentId?: string | null;
  agentDisplayName?: string | null;
  agentAvatarUrl?: string | null;
  agentAvatarSeed?: string | null;
  role?: string | null;
  joinedAt?: string | null;
};

export type CloudGroupActor = CloudGroupParticipant;

export function compareCloudGroupParticipants(
  left: CloudGroupParticipant,
  right: CloudGroupParticipant,
) {
  const leftJoinedAt = left.joinedAt?.trim() ?? '';
  const rightJoinedAt = right.joinedAt?.trim() ?? '';
  if (leftJoinedAt !== rightJoinedAt) {
    if (!leftJoinedAt) return 1;
    if (!rightJoinedAt) return -1;
    return leftJoinedAt.localeCompare(rightJoinedAt);
  }
  return left.accountId.localeCompare(right.accountId);
}

export function cloudGroupTransportParticipant(
  participant: CloudGroupParticipant,
): CloudGroupParticipant {
  return { ...participant, avatarUrl: null, agentAvatarUrl: null };
}
