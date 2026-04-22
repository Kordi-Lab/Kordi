import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { SettingsSectionId } from '@/kordi-app/data/settings';
import type {
  ComposerScope,
  ComposerSelectorType,
  DesktopBridgeState,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  Message,
  NavId,
  Project,
} from '@/kordi-app/types';

export type ComposerSelectionState = Record<ComposerScope, { mode: string; model: string; thinking: string }>;
export type ComposerDraftState = Record<ComposerScope, string>;
export type ComposerSelectorState = { scope: ComposerScope; type: ComposerSelectorType } | null;
export type AttachmentItem = { id: string; name: string; path: string; kind: 'image' | 'file' };
export type MinimalModelOption = {
  value: string;
  label: string;
  detail?: string | null;
  provider?: string | null;
  providerLabel?: string | null;
};
export type MinimalProviderOption = { providerId: string; value: string };
export type PendingUserMessage = { text: string; time: string } | null;

export type UseComposerControllerArgs = {
  isNativeShell: boolean;
  activeConversationIsBridge: boolean;
  activeConvId: string;
  activeConvMessages: Message[];
  activeProjectId: string;
  activeProjectSessionId: string;
  desktopChatState: DesktopChatState | null;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  composerSelections: ComposerSelectionState;
  setComposerSelections: Dispatch<SetStateAction<ComposerSelectionState>>;
  composerDrafts: ComposerDraftState;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setProjectWorkspaces: Dispatch<SetStateAction<Project[]>>;
  setOpenComposerSelector: Dispatch<SetStateAction<ComposerSelectorState>>;
  chatComposerAttachments: AttachmentItem[];
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  chatModelOptions: MinimalModelOption[];
  preferredModelValueForProvider: (providerId: string) => string | null;
  resolveComposerProviderId: (scope: ComposerScope, modelLabel: string) => string;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  refreshDesktopAuth: () => Promise<unknown>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  handleCreateChatSession: () => Promise<void>;
  handleRenameDesktopSession: (fallbackName?: string) => Promise<void>;
  setActiveNav: (nav: NavId) => void;
  setActiveSettingsSectionId: (sectionId: SettingsSectionId) => void;
  setActiveDetailTab: (tab: DetailTab) => void;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setIsDesktopChatSending: Dispatch<SetStateAction<boolean>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<PendingUserMessage>>;
  setDesktopBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  watchDesktopLiveTurn: (turn: DesktopChatTurnSnapshot | string) => Promise<void>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
};
