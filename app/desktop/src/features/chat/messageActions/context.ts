import type { DesktopChatState } from '@/kordi-app/types';

import type { UseComposerControllerArgs } from '../composerController.types';

export function renderProjectContext(state: DesktopChatState | null) {
  const project = state?.activeSession.project;
  if (!project) return null;

  const lines = [
    `Project: ${project.name}`,
    project.sharedContext ? `Context: ${project.sharedContext}` : null,
    project.backgroundSystem ? `Standing instruction: ${project.backgroundSystem}` : null,
    project.sharedSources.length > 0
      ? `Shared sources: ${project.sharedSources.map((source) => [source.label, source.detail].filter(Boolean).join(' — ')).join('; ')}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join('\n') : null;
}

export function renderRecentMessageContext(
  messages: UseComposerControllerArgs['conversation']['activeConvMessages'],
) {
  const lines = messages
    .filter((message) => message.text?.trim())
    .slice(-8)
    .map((message) => `${message.sender || message.role}: ${message.text.trim()}`);
  return lines.length > 0 ? `Recent session messages:\n${lines.join('\n')}` : null;
}

export function parentSessionMessagesForOutreach(
  messages: UseComposerControllerArgs['conversation']['activeConvMessages'],
) {
  return messages.flatMap((message, index) => {
    const text = (message.turn?.assistantText || message.text || '').trim();
    if (!text) return [];
    if (message.role === 'action' || message.role === 'edit') return [];
    return [{
      role: message.role,
      sender: message.sender ?? null,
      text,
      timeLabel: message.time ?? null,
      index,
    }];
  });
}

export function combineContext(...parts: Array<string | null | undefined>) {
  const lines = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return lines.length > 0 ? lines.join('\n\n') : null;
}
