import type { ConversationParticipant } from './types';
export type SessionTaskParticipant = Pick<ConversationParticipant,
  | 'id'
  | 'name'
  | 'kind'
  | 'role'
  | 'source'
  | 'ownerIdentityId'
  | 'ownerName'
  | 'sourceHostId'
  | 'sourceIdentityId'
  | 'humanId'
  | 'agentId'
  | 'avatarKey'
  | 'profileImageUrl'
>;

export type SessionTaskActivity = {
  id: string;
  sessionId: string;
  status: string;
  initiator: SessionTaskParticipant | null;
  target: SessionTaskParticipant | null;
  participants: SessionTaskParticipant[];
  createdAtMs: number;
  updatedAtMs: number;
  sourceConversationId?: string | null;
  sourceRequestId?: string | null;
  contextPolicy: string;
  error?: string | null;
};
