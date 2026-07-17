import type { ComposerScope } from '@/kordi-app/types';
import { runDesktopChatSkillCommand } from '@/lib/desktop';

import {
  desktopHotkeyHelpText,
  desktopSlashHelpText,
  formatDesktopEventTime,
  isSharedLocalSlashCommand,
} from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
import { isLocalDraftChatConversationId } from '../draftSessions';

type AppendDesktopSystemMessageArgs = Pick<UseComposerControllerArgs, 'setDesktopChatState'>;

type RunLocalSlashCommandArgs = Pick<
  UseComposerControllerArgs,
  | 'activeConvId'
  | 'activeConvMessages'
  | 'chatModelOptions'
  | 'desktopChatState'
  | 'handleCreateChatSession'
  | 'handleRenameDesktopSession'
  | 'refreshDesktopAuth'
  | 'refreshDesktopChat'
  | 'setActiveDetailTab'
  | 'setActiveNav'
  | 'setActiveSettingsSectionId'
  | 'setDesktopSessionRenameDraft'
  | 'setIsDetailPanelCollapsed'
  | 'setIsEditingDesktopSessionTitle'
  | 'setOpenComposerSelector'
> & {
  rawText: string;
  scope: ComposerScope;
  appendDesktopSystemMessage: (text: string) => void;
  selectComposerValue: (scope: ComposerScope, type: 'model', value: string) => Promise<void>;
};

export function appendDesktopSystemMessageToState(
  { setDesktopChatState }: AppendDesktopSystemMessageArgs,
  text: string,
) {
  const timeLabel = formatDesktopEventTime();
  setDesktopChatState((current) => {
    if (!current) return current;
    return {
      ...current,
      activeSession: {
        ...current.activeSession,
        messages: [
          ...current.activeSession.messages,
          {
            role: 'system',
            sender: 'Kordi',
            text,
            timeLabel,
            timestampMs: Date.now(),
          },
        ],
      },
    };
  });
}

export async function runLocalSlashCommand({
  rawText,
  scope,
  activeConvId,
  activeConvMessages,
  appendDesktopSystemMessage,
  chatModelOptions,
  desktopChatState,
  handleCreateChatSession,
  handleRenameDesktopSession,
  refreshDesktopAuth,
  refreshDesktopChat,
  selectComposerValue,
  setActiveDetailTab,
  setActiveNav,
  setActiveSettingsSectionId,
  setDesktopSessionRenameDraft,
  setIsDetailPanelCollapsed,
  setIsEditingDesktopSessionTitle,
  setOpenComposerSelector,
}: RunLocalSlashCommandArgs) {
  const text = rawText.trim();
  const command = text.split(/\s+/, 1)[0] ?? text;
  if (!isSharedLocalSlashCommand(command)) {
    return false;
  }

  const args = text.slice(command.length).trim();

  switch (command) {
    case '/new':
      await handleCreateChatSession();
      return true;
    case '/settings':
      setActiveNav('settings');
      return true;
    case '/login':
    case '/logout':
      setActiveNav('settings');
      setActiveSettingsSectionId('auth');
      return true;
    case '/session':
      setIsDetailPanelCollapsed(false);
      setActiveDetailTab('info');
      return true;
    case '/model': {
      if (args) {
        const match = chatModelOptions.find((option) => {
          const haystack = `${option.value} ${option.label} ${option.detail ?? ''}`.toLowerCase();
          return haystack.includes(args.toLowerCase());
        });
        if (match) {
          await selectComposerValue(scope, 'model', match.value);
          return true;
        }
      }
      setOpenComposerSelector({ scope, type: 'model' });
      return true;
    }
    case '/name': {
      if (!desktopChatState?.activeSessionId && !isLocalDraftChatConversationId(activeConvId)) {
        return true;
      }
      const activeSessionTitle = isLocalDraftChatConversationId(activeConvId)
        ? 'New chat'
        : desktopChatState?.activeSession.title ?? 'New chat';
      if (args) {
        setDesktopSessionRenameDraft(args);
        await handleRenameDesktopSession(activeSessionTitle);
      } else {
        setDesktopSessionRenameDraft(activeSessionTitle);
        setIsEditingDesktopSessionTitle(true);
      }
      return true;
    }
    case '/copy': {
      const lastAssistant = [...activeConvMessages].reverse().find((message) => message.role === 'owned-agent');
      if (!lastAssistant?.text?.trim()) {
        appendDesktopSystemMessage('No assistant response available to copy yet.');
        return true;
      }
      await navigator.clipboard.writeText(lastAssistant.text);
      appendDesktopSystemMessage('Copied the latest assistant response to your clipboard.');
      return true;
    }
    case '/help':
      appendDesktopSystemMessage(desktopSlashHelpText());
      return true;
    case '/hotkeys':
      appendDesktopSystemMessage(desktopHotkeyHelpText());
      return true;
    case '/reload':
      await Promise.all([refreshDesktopChat(desktopChatState?.activeSessionId), refreshDesktopAuth()]);
      appendDesktopSystemMessage('Reloaded desktop chat state, auth, and slash commands.');
      return true;
    case '/skill': {
      if (!desktopChatState?.activeSessionId) return true;
      const note = await runDesktopChatSkillCommand(desktopChatState.activeSessionId, text);
      await refreshDesktopChat(desktopChatState.activeSessionId);
      appendDesktopSystemMessage(note);
      return true;
    }
    default:
      appendDesktopSystemMessage(`${command} is not wired on desktop yet.`);
      return true;
  }
}
