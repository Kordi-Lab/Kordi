import type { Dispatch, SetStateAction } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type {
  CanonicalSessionState,
  Contact,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
  MessageAttachment,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudSessionPin,
  UpsertCloudArtifactActivityInput,
  UpsertCloudTaskActivityInput,
} from './authClient';
import type {
  CloudAgentDefinition,
  SharedCloudAgentSummary,
} from './cloudAgents';
import type {
  CreateCloudAgentInput,
  UpdateCloudAgentInput,
} from './cloudAgentsClient';
import type { CloudSessionPinsById } from './cloudDiffSync';
import type { CloudUnreadReadinessStatus } from './cloudMessageSyncState';
import type { CloudSessionActivityStore } from './cloudSessionActivity';
import type { SendCloudGroupControlInput } from './useCloudGroupControlSender';
import type {
  SendCloudCollaborationMessageOptions,
} from './useCloudDirectMessaging';

export type UseCloudCollaborationStateArgs = {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  canonicalSessionState?: CanonicalSessionState | null;
  setCanonicalSessionState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  localTurnsBySessionId?: Record<string, DesktopChatTurnSnapshot>;
  cloudAgentRuntimeRoutesBySessionId?: Record<
    string,
    DesktopChatMessageRoute
  >;
  defaultCloudAgentRuntimeRoute?: DesktopChatMessageRoute | null;
};

export type UseCloudCollaborationStateResult = {
  cloudCollaborationState: DesktopCollaborationState | null;
  setCloudCollaborationState:
    Dispatch<SetStateAction<DesktopCollaborationState | null>>;
  mergedCollaborationState: DesktopCollaborationState | null;
  prepareCloudForwardAttachments:
    (attachments: MessageAttachment[]) => Promise<AttachmentItem[]>;
  sendCloudCollaborationMessage: (
    conversationId: string,
    text: string,
    attachments?: AttachmentItem[],
    options?: SendCloudCollaborationMessageOptions,
  ) => Promise<void>;
  sendCloudGroupControl: (input: SendCloudGroupControlInput) => Promise<void>;
  recordCloudSessionFork: (input: {
    sourceSessionId: string;
    forkSessionId: string;
    parentMessageId?: string | null;
  }) => Promise<void>;
  updateCloudSessionPin: (input: {
    sessionId: string;
    messageId: string | null;
    scope: 'private' | 'shared';
  }) => Promise<CloudSessionPin>;
  hideCloudSession: (sessionId: string) => Promise<void>;
  unhideCloudSession: (sessionId: string) => Promise<void>;
  deleteCloudSession: (sessionId: string) => Promise<void>;
  cancelCloudAgentRequest:
    (conversationId: string, requestId: string) => Promise<void>;
  refreshCloudMessages: () => Promise<void>;
  refreshCloudAgents: () => Promise<void>;
  createCloudAgentDefinition:
    (input: CreateCloudAgentInput) => Promise<CloudAgentDefinition>;
  updateCloudAgentDefinition: (
    agentId: string,
    input: UpdateCloudAgentInput,
  ) => Promise<CloudAgentDefinition>;
  archiveCloudAgentDefinition:
    (agentId: string) => Promise<CloudAgentDefinition>;
  refreshSharedCloudAgents:
    (ownerAccountIds: string[]) => Promise<SharedCloudAgentSummary[]>;
  cloudAgentDefinitionsById: Record<string, CloudAgentDefinition>;
  sharedCloudAgents: SharedCloudAgentSummary[];
  cloudSessionActivity: CloudSessionActivityStore;
  refreshCloudSessionActivity: (sessionId: string) => Promise<void>;
  publishCloudTaskActivity:
    (input: UpsertCloudTaskActivityInput) => Promise<void>;
  publishCloudArtifactActivity:
    (input: UpsertCloudArtifactActivityInput) => Promise<void>;
  refreshCloudContacts: () => Promise<void>;
  cloudContacts: Contact[];
  initialContactsSettled: boolean;
  initialMessagesSettled: boolean;
  cloudUnreadReadinessStatus: CloudUnreadReadinessStatus;
  cachedMessagesReady: boolean;
  cloudHiddenSessionIds: Set<string>;
  cloudDeletedSessionIds: Set<string>;
  cloudSessionPinsById: CloudSessionPinsById;
};
