import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ComposerScope, DesktopCollaborationState } from '@/kordi-app/types';
import type { ComposerMentionOption } from '@/kordi-app/components';
import type {
  ComposerAuthNavigationContext,
  ComposerConversationContext,
  ComposerDraftContext,
  ComposerEnvironmentContext,
  ComposerMessageRuntimeContext,
  ComposerRuntimeContext,
  AttachmentItem,
} from '../composerController.types';

export type ResolvedMentionedCollaborationTarget = {
  host: DesktopCollaborationState['hosts'][number];
  peer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
  label: string;
  displayLabel: string;
  targetKind: 'person' | 'agent';
  requestText: string;
};

export type PendingCollaborationOutreach = {
  conversationId: string;
  requestId?: string | null;
  parentSessionId: string;
};

export type LocalChatSendInFlight = {
  sessionId: string | null;
};

export type UseChatMessageActionsArgs = Pick<
  ComposerConversationContext,
  | 'activeConversationUsesCollaboration'
  | 'activeConvCollaborationTarget'
  | 'activeConvSupportTicketEnabled'
  | 'activeConvCanonicalSessionId'
  | 'activeConvId'
  | 'activeConvMessages'
  | 'activeConvMentionScope'
  | 'sharedCloudAgents'
  | 'resolveSharedCloudAgentsForMention'
  | 'chatConversations'
> & Pick<
  ComposerRuntimeContext,
  | 'canonicalHumanIdentityId'
  | 'desktopCollaborationState'
  | 'desktopChatState'
  | 'canonicalSessionState'
  | 'desktopLiveTurn'
  | 'resolveChatRuntimeRoute'
  | 'setCanonicalSessionState'
> & Pick<
  ComposerDraftContext,
  | 'chatComposerAttachments'
  | 'composerSelections'
  | 'composerDrafts'
  | 'activeChatQuote'
  | 'setChatComposerAttachments'
  | 'setComposerDrafts'
  | 'setOpenComposerSelector'
> & Pick<
  ComposerEnvironmentContext,
  'hasAnyDesktopAuth' | 'isNativeShell'
> & Pick<
  ComposerMessageRuntimeContext,
  | 'isDesktopChatSending'
  | 'queuedDesktopMessagesBySession'
  | 'setActiveConvId'
  | 'setCloudCollaborationState'
  | 'sendCloudCollaborationMessage'
  | 'sendCloudGroupControl'
  | 'publishCloudAgentRuntimeRouteChange'
  | 'setDesktopChatError'
  | 'setDesktopChatState'
  | 'setDesktopLiveTurnsBySession'
  | 'setIsDesktopChatSending'
  | 'setPendingUserChatMessage'
  | 'setQueuedDesktopMessagesBySession'
  | 'shouldAutoFollowChatRef'
  | 'watchDesktopLiveTurn'
> & Pick<
  ComposerAuthNavigationContext,
  'refreshDesktopChat'
> & {
  attachmentSummaryText: (text: string, attachments?: AttachmentItem[]) => string;
  handleLocalSlashCommand: (
    rawText: string,
    scope?: ComposerScope,
  ) => Promise<boolean>;
  pendingCollaborationCancelRequestedRef: MutableRefObject<boolean>;
  collaborationSendInFlightConversationIdsRef: MutableRefObject<Set<string>>;
  localChatSendInFlightRef: MutableRefObject<LocalChatSendInFlight | null>;
  selectedChatAgentMentionRef: MutableRefObject<ComposerMentionOption | null>;
  userCancelledTurnIdsRef: MutableRefObject<Set<string>>;
  setPendingCollaborationOutreach: Dispatch<
    SetStateAction<PendingCollaborationOutreach | null>
  >;
};
