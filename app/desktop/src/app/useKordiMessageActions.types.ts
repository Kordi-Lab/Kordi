import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { CloudAccount } from '@/features/cloud/authClient';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import type { ForwardMessageSource } from '@/features/chat/messageActionMetadata';
import type { ForwardDestination } from '@/features/chat/messageForwarding';
import type { CanonicalSessionState, ComposerQuoteState, Conversation, Contact, DesktopCollaborationState } from '@/kordi-app/types';

type MessageActionCloudTransport = Pick<
  UseCloudCollaborationStateResult,
  | 'prepareCloudForwardAttachments'
  | 'sendCloudCollaborationMessage'
  | 'sendCloudGroupControl'
  | 'setCloudMessageReaction'
  | 'editCloudMessage'
  | 'deleteCloudMessage'
>;

export type UseKordiMessageActionsArgs = {
  activeConversation: Conversation;
  conversations: Conversation[];
  contacts?: Contact[];
  draftSessionId: string;
  isNativeShell: boolean;
  transcriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  setActiveConversationId: (conversationId: string) => void;
  setDesktopChatError: (message: string | null) => void;
  setChatQuoteBySessionId: Dispatch<
    SetStateAction<Record<string, ComposerQuoteState | null>>
  >;
  canonicalState: CanonicalSessionState | null;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  account: CloudAccount | null;
  collaborationState: DesktopCollaborationState | null;
  cloudTransport: MessageActionCloudTransport;
};

export type ForwardDialogState = {
  sourceLabel: string;
  sources: ForwardMessageSource[];
  destinations: ForwardDestination[];
};

export type ForwardBatchProgress = {
  destinationId: string;
  requestIds: string[];
  now: number;
  nextIndex: number;
  appended: Set<string>;
  lastMessageId: string | null;
};
