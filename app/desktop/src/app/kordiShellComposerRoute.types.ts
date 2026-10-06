import type { ComposerAuthOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

export type KordiShellComposerRouteArgs = {
  composerAuthLabelProject: string;
  composerAuthLabelChat: string;
  composerAuthOptionsProject: ComposerAuthOption[];
  composerAuthOptionsChat: ComposerAuthOption[];
  resolveChatRuntimeRoute?: (sessionId?: string | null) => DesktopChatMessageRoute | null;
  selectComposerAuthChoice: (scope: 'chat' | 'project', providerId: string, choice: string, configTargetOverride?: ComposerConfigTargetOverride) => void;
  selectComposerProviderChoice: (scope: 'chat' | 'project', option: ComposerProviderOption, configTargetOverride?: ComposerConfigTargetOverride) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions: ComposerModelOption[] | undefined;
  defaultCloudAgentRuntimeRoute: DesktopChatMessageRoute | null;
};
