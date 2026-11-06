import type { Dispatch, SetStateAction } from 'react';
import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import type { ComposerDraftState } from '@/features/chat/composerDrafts';
import type { CanonicalSessionState, DesktopChatState, Conversation } from '@/kordi-app/types';

export type UseKordiChatSessionActionsArgs = {
  conversations?: readonly Conversation[];
  account: CloudAccount | null;
  activeConversationId: string;
  canonicalState: CanonicalSessionState | null;
  desktopState: DesktopChatState | null;
  isNativeShell: boolean;
  deleteCloudSession: (sessionId: string) => Promise<void>;
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
  refreshCanonicalState: () => Promise<void>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<void>;
  sendCloudGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setDesktopState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setLocallyHiddenSessionIds: Dispatch<SetStateAction<Set<string>>>;
};
