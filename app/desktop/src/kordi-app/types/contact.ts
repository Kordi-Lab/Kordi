export type ContactClass = 'my-agents' | 'other-users-agents' | 'other-users';

type SystemContactMetadata = {
  /** Server-owned contacts cannot be removed or edited by a client. */
  systemContact?: boolean;
  locked?: boolean;
  supportTicketEnabled?: boolean;
  targetCloudAgentId?: string | null;
  targetCloudAgentName?: string | null;
  targetCloudAgentOwnerAccountId?: string | null;
  targetCloudAgentOwnerName?: string | null;
  targetCloudAgentAvatarUrl?: string | null;
  targetCloudAgentAvatarSeed?: string | null;
};

export type Contact = SystemContactMetadata & {
  id: string;
  name: string;
  initials: string;
  classType: ContactClass;
  entityType: string;
  subtitle: string;
  collaborationSources: string[];
  status: string;
  discoverableOn: string[];
  detail: string;
  owner: string;
  sourceHostId?: string;
  sourceParticipantId?: string;
  sourceRuntime?: string;
  sourceHumanId?: string | null;
  sourceAgentId?: string | null;
  contactStatus?: string | null;
  contactRequestDirection?: string | null;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
  presenceStatus?: string | null;
};
