import type { AttachmentItem, ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import type { CompactComposerModelMenuSaveInput } from '@/kordi-app/components';
import type { Conversation, DesktopChatContextWindowStatus } from '@/kordi-app/types';
import type {
  CollaborationRoutingControlsModel,
  CollaborationRoutingPatch,
} from '@/pages/chatsPage.collaborationRoutingControls';
import type { ChatsPageComposer, ChatsPageRuntime } from '@/pages/chatsPage.types';
import type { ComposerStopControl } from '@/pages/chatsPage.voiceControls';

type MainComposerLocalRouting = {
  paneKind: 'human' | 'agent' | null;
  configTarget: ComposerConfigTargetOverride;
  contextStatus: DesktopChatContextWindowStatus | null | undefined;
  cacheText: string | null | undefined;
};

type MainComposerCollaborationRouting = {
  enabled: boolean;
  notice: string | null;
  /** A model pick whose save failed and was rolled back. */
  error?: string | null;
  model: CollaborationRoutingControlsModel | null;
  agentSelectorOpen: boolean;
  onSelectAgent: (agentId: string) => void;
  onUpdate: (patch: CollaborationRoutingPatch) => void | boolean | Promise<void | boolean>;
  onSaveCompact: (input: CompactComposerModelMenuSaveInput) => void | boolean | Promise<void | boolean>;
  defaultThinkingForModel: (
    modelValue: string | null | undefined,
    currentThinking: string | null | undefined,
  ) => string;
};

export type MainComposerProps = {
  conversation: Conversation;
  composer: ChatsPageComposer;
  runtime: ChatsPageRuntime;
  localRouting: MainComposerLocalRouting;
  collaborationRouting: MainComposerCollaborationRouting;
  display: {
    isNativeShell: boolean;
    showCompanionPane: boolean;
    activeLiveTurnIsRunning: boolean;
    prefersReducedMotion: boolean | null;
    placeholder: string;
    /** Opens sign-in when no account can run the agent. */
    onOpenAuthentication?: () => void;
  };
  onSend: (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  /** Present while a request the viewer sent in this chat runs or waits. */
  stop?: ComposerStopControl | null;
  cloudAccountId?: string | null;
};
