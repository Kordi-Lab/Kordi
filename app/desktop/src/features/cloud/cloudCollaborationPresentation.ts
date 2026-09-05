import {
  COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/collaboration/messages';
import type { Contact, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import type { CloudAgentResponseEnvelope } from './cloudAgentMessages';

export function cloudAgentBackgroundTurnForMessage(
  message: CloudMessage,
  response: CloudAgentResponseEnvelope | null,
): DesktopChatTurnSnapshot | null {
  if (!response?.backgroundSessions?.length) return null;
  const completed = response.deliveryState !== 'processing';
  const failed = response.deliveryState === 'failed';
  const cancelled = response.deliveryState === 'cancelled';
  const timestampMs = Date.parse(message.createdAt) || Date.now();
  return {
    id: `cloud-agent-background:${message.messageId}`,
    sessionId: message.sessionId ?? `cloud-agent:${response.requestId}`,
    prompt: '',
    status: cancelled ? 'cancelled' : failed ? 'failed' : completed ? 'succeeded' : 'processing',
    message: response.text,
    assistantText: response.text,
    thinkingText: '',
    tools: response.backgroundSessions.map((session) => ({
      id: `background-session:${session.sessionId}`,
      name: 'task_operator',
      status: 'completed',
      arguments: JSON.stringify({ taskTitle: session.title, summary: session.summary }),
      liveOutput: '',
      resultText: `Background session: ${JSON.stringify(session)}`,
      detail: session.summary ?? session.title,
      isError: false,
      toolLayer: 'operator',
    })),
    completed,
    succeeded: completed && !failed && !cancelled,
    startedAtMs: timestampMs,
    completedAtMs: completed ? timestampMs : null,
    error: failed ? response.text : null,
    transcriptRefreshRequired: false,
  };
}

export function cloudAgentSyntheticResponseDirection(
  account: CloudAccount,
  targetAccountId: string,
) {
  return targetAccountId === account.accountId
    ? COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
    : COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE;
}

export function isDirectCloudContact(contact: Contact): boolean {
  return contact.contactStatus?.trim().toLowerCase() !== 'group-member';
}
