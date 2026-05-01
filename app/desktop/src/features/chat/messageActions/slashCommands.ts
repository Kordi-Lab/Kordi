import type { ComposerScope } from '@/kordi-app/types';
import { runDesktopChatLocalCommand } from '@/lib/desktop';

import {
  formatDesktopEventTime,
  isDesktopHandledSlashCommand,
} from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';

type AppendDesktopSystemMessageArgs = Pick<UseComposerControllerArgs, 'setDesktopChatState'>;

type RunLocalSlashCommandArgs = Pick<
  UseComposerControllerArgs,
  | 'desktopChatState'
  | 'refreshDesktopAuth'
  | 'refreshDesktopChat'
> & {
  rawText: string;
  scope: ComposerScope;
  appendDesktopSystemMessage: (text: string) => void;
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
  appendDesktopSystemMessage,
  desktopChatState,
  refreshDesktopAuth,
  refreshDesktopChat,
}: RunLocalSlashCommandArgs) {
  const text = rawText.trim();
  const command = text.split(/\s+/, 1)[0] ?? text;
  const catalog = desktopChatState?.slashCommands ?? [];
  if (!isDesktopHandledSlashCommand(command, catalog)) {
    return false;
  }

  if (command === '/fork') {
    appendDesktopSystemMessage('Desktop /fork is reserved for the upcoming message fork flow (#172).');
    return true;
  }
  if (command === '/tree') {
    appendDesktopSystemMessage('Desktop /tree is reserved for the upcoming session branch browser (#173).');
    return true;
  }

  const sessionId = desktopChatState?.activeSessionId;
  if (!sessionId) {
    appendDesktopSystemMessage(`Start a local desktop chat session before running ${command}.`);
    return true;
  }

  try {
    const note = await runDesktopChatLocalCommand(sessionId, text);
    await refreshDesktopChat(sessionId);
    if (command === '/reload' || command === '/install' || command === '/skill' || command.startsWith('/skill:')) {
      await refreshDesktopAuth();
    }
    if (note.trim()) appendDesktopSystemMessage(note);
  } catch (error) {
    appendDesktopSystemMessage(error instanceof Error ? error.message : `Unable to run ${command}.`);
  }
  return true;
}
