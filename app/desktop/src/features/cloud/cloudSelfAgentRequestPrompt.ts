import { voiceAgentText } from '@/features/chat/voiceTranscription';
import type { CloudMessage } from './authClient';
import { cloudDirectMessageDisplayText } from './cloudDirectMessages';

/**
 * The prompt an Ask Agent request runs with. A request with only attachments,
 * such as a screenshot, names them, so it still creates its run: an empty
 * prompt is refused by the run claim and the request would never start.
 */
export function cloudSelfAgentRequestPrompt(
  message: Pick<CloudMessage, 'body' | 'voiceMessage' | 'attachments'>,
): string {
  const text = (message.voiceMessage
    ? voiceAgentText(message.voiceMessage)
    : cloudDirectMessageDisplayText(message.body)).trim();
  if (text) return text;
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return '';
  return attachments.length === 1
    ? `Attached ${attachments[0].name?.trim() || 'a file'}`
    : `${attachments.length} attachments`;
}
