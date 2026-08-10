import type {
  AttachmentItem,
} from '@/features/chat/composerController.types';
import type {
  DesktopCollaborationSessionParticipant,
} from '@/kordi-app/types';
import type {
  CloudGroupControlEnvelope,
  CloudGroupMemberJoin,
  CloudGroupMemberLeave,
  CloudGroupParticipant,
} from './cloudGroupMessages';

export type SendCloudGroupControlInput = {
  /** Stable identity for one logical control mutation and all of its retries. */
  operationId?: string | null;
  targetAccountIds: string[];
  kind: CloudGroupControlEnvelope['kind'];
  groupId: string;
  groupSpaceId?: string | null;
  groupTitle?: string | null;
  createdByAccountId?: string | null;
  actor?: CloudGroupParticipant | null;
  participants?: CloudGroupParticipant[];
  memberJoins?: CloudGroupMemberJoin[];
  memberLeaves?: CloudGroupMemberLeave[];
  sessionTitleSyncOnly?: boolean;
  collaborationParticipants?: DesktopCollaborationSessionParticipant[];
  fork?: CloudGroupControlEnvelope['fork'];
  message?: CloudGroupControlEnvelope['message'];
  attachments?: AttachmentItem[];
  retryFailed?: boolean;
};
