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
  model: CollaborationRoutingControlsModel | null;
  agentSelectorOpen: boolean;
  onSelectAgent: (agentId: string) => void;
  onUpdate: (patch: CollaborationRoutingPatch) => void;
  onSaveCompact: (input: CompactComposerModelMenuSaveInput) => void;
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
  };
  onSend: (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  /** Present while a request the viewer sent in this chat runs or waits. */
  stop?: ComposerStopControl | null;
  cloudAccountId?: string | null;
};
