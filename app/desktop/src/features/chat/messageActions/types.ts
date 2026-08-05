import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ComposerScope, DesktopCollaborationState } from '@/kordi-app/types';
import type {
  ComposerAuthNavigationContext,
  ComposerConversationContext,
  ComposerDraftContext,
  ComposerEnvironmentContext,
  ComposerMessageRuntimeContext,
  ComposerRuntimeContext,
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
  attachmentSummaryText: (text: string) => string;
  handleLocalSlashCommand: (
    rawText: string,
    scope?: ComposerScope,
  ) => Promise<boolean>;
  pendingCollaborationCancelRequestedRef: MutableRefObject<boolean>;
  localChatSendInFlightRef: MutableRefObject<LocalChatSendInFlight | null>;
  userCancelledTurnIdsRef: MutableRefObject<Set<string>>;
  setPendingCollaborationOutreach: Dispatch<
    SetStateAction<PendingCollaborationOutreach | null>
  >;
};
