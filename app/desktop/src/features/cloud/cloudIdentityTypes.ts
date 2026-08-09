export type CloudAccount = {
  accountId: string;
  /** Public nine-digit identity. Optional while cached pre-migration sessions refresh. */
  kordiId?: string | null;
  displayName: string | null;
  primaryEmail: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  passwordSet: boolean;
};

export type CloudPublicProfile = {
  accountId: string;
  kordiId?: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  isContact: boolean;
  isSelf: boolean;
};

export type CloudAppInvitation = {
  invitationId: string;
  inviteUrl: string;
  expiresAt: string;
};

export type CloudGroupInvitationCreateInput = {
  groupId: string;
  groupSpaceId: string;
  groupTitle: string;
};

export type CloudGroupInvitation = CloudAppInvitation;

export type CloudGroupInvitationSummary = {
  invitationId: string;
  expiresAt: string;
};

export type CloudGroupInvitationPreview = {
  inviter: {
    displayName: string | null;
    kordiId: string;
    avatarUrl: string | null;
  };
  group: {
    name: string;
    memberCount: number;
  };
  expiresAt: string;
};

export type CloudGroupInvitationAcceptance = {
  status: 'joined' | 'already_joined';
  groupId: string;
  groupSpaceId: string;
  groupTitle: string;
};
