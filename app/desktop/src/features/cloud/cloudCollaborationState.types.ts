import type { Dispatch, SetStateAction } from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type {
  CanonicalSessionState,
  Contact,
  DesktopAuthState,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
  MessageAttachment,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudMessage,
  CloudSessionPin,
  CloudSessionTitle,
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
  canMarkActiveConversationRead: boolean;
  canonicalSessionState?: CanonicalSessionState | null;
  setCanonicalSessionState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  hydrateCanonicalSessionPage?: (
    sessionId: string,
    options?: { beforeSequenceNum?: number | null; force?: boolean },
  ) => Promise<unknown>;
  localTurnsBySessionId?: Record<string, DesktopChatTurnSnapshot>;
  cloudAgentRuntimeRoutesBySessionId?: Record<
    string,
    DesktopChatMessageRoute
  >;
  defaultCloudAgentRuntimeRoute?: DesktopChatMessageRoute | null;
  localAgentLabel?: string | null;
  defaultCloudAgentRuntimeReady?: boolean;
  desktopAuthState?: DesktopAuthState | null;
};

export type UseCloudCollaborationStateResult = {
  cloudAgentRuntimeRouteMessages: CloudMessage[];
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
  ) => Promise<CloudMessage>;
  editCloudMessage: (input: {
    conversationId: string;
    messageId: string;
    expectedVersion: number;
    text: string;
  }) => Promise<CloudMessage>;
  deleteCloudMessage: (input: {
    conversationId: string;
    messageId: string;
    forEveryone: boolean;
  }) => Promise<void>;
  updateCloudCollaborationSessionTitle: (
    sessionId: string,
    title: string,
  ) => Promise<CloudSessionTitle>;
  sendCloudGroupControl: (input: SendCloudGroupControlInput) => Promise<void>;
  setCloudMessageReaction: (input: {
    conversationId: string;
    messageId: string;
    reaction: string;
    active: boolean;
  }) => Promise<CloudMessage>;
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
  setCloudSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
  setCloudSessionMuted: (sessionId: string, muted: boolean) => Promise<void>;
  setCloudSessionUnread: (sessionId: string, unread: boolean) => Promise<void>;
  markCloudSessionsRead: (sessionIds: string[]) => Promise<void>;
  setCloudGroupSpacePinned: (groupSpaceId: string, pinned: boolean) => Promise<void>;
  setCloudGroupSpaceMuted: (
    groupSpaceId: string,
    sessionIds: string[],
    muted: boolean,
  ) => Promise<void>;
  setCloudGroupSpaceArchived: (
    groupSpaceId: string,
    sessionIds: string[],
    archived: boolean,
  ) => Promise<void>;
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
  pendingGroupProjectionSessionIds: ReadonlySet<string>;
  cloudHiddenSessionIds: Set<string>;
  cloudDeletedSessionIds: Set<string>;
  cloudUnreadSessionIds: Set<string>;
  cloudPinnedSessionIds: Set<string>;
  cloudMutedSessionIds: Set<string>;
  cloudPinnedGroupSpaceIds: Set<string>;
  cloudSessionPinsById: CloudSessionPinsById;
  cloudCanonicalReactionState: CanonicalSessionState | null;
  cloudLegacyGroupSessionTitlesById: ReadonlyMap<string, string>;
  cloudReliableGroupSessionTitleIds: ReadonlySet<string>;
  cloudReliableGroupSessionActivityAtMs: ReadonlyMap<string, number>;
};
