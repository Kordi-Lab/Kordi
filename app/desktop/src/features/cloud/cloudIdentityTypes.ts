import type { CanonicalAvatarDescriptor } from './canonicalAvatar';

export type CloudDefaultAgentProfile = {
  agentId: string;
  displayName: string;
  avatarUrl: string | null;
  avatar: CanonicalAvatarDescriptor;
};

export type CloudAccount = {
  accountId: string;
  /** Public Kordi ID (nine-digit number or chosen handle). Optional while cached pre-migration sessions refresh. */
  kordiId?: string | null;
  /** The nine-digit account number, kept when a handle is chosen. Owner payload only. */
  accountNumber?: string | null;
  /** RFC 3339 time the Kordi ID can change again (once per year); null when it can change now. */
  kordiIdChangeAvailableAt?: string | null;
  displayName: string | null;
  primaryEmail: string | null;
  /** Whether the account has proved it can read its primary email. Undefined on older servers. */
  primaryEmailVerified?: boolean;
  about?: string | null;
  location?: string | null;
  /** IANA time zone id; null means automatic. */
  timeZone?: string | null;
  website?: string | null;
  /** "YYYY-MM-DD"; private to the account owner. */
  birthday?: string | null;
  avatarUrl: string | null;
  avatar: CanonicalAvatarDescriptor;
  /** Optional while cached sessions from before default-agent profiles refresh. */
  defaultAgent?: CloudDefaultAgentProfile | null;
  nodeId: string | null;
  passwordSet: boolean;
};

/** Optional profile fields on PATCH /me, each a string where "" clears it. */
export type CloudProfileFieldsInput = {
  /** Chosen handle, or "" to go back to the account number. */
  kordiId?: string;
  about?: string;
  location?: string;
  /** IANA time zone id; "" means automatic. */
  timeZone?: string;
  website?: string;
  /** "YYYY-MM-DD". */
  birthday?: string;
};

export type CloudPublicProfile = {
  accountId: string;
  kordiId?: string | null;
  displayName: string | null;
  about?: string | null;
  location?: string | null;
  timeZone?: string | null;
  website?: string | null;
  avatarUrl: string | null;
  defaultAgent?: CloudDefaultAgentProfile | null;
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
