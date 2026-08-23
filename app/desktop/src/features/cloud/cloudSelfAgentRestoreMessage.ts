import type { MessageActionMetadata, MessageMention } from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import {
  CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
  cloudAgentRuntimeRouteChangeFromBody,
} from './cloudAgentRuntime';
import {
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  type CloudAgentExecutionSnapshot,
} from './cloudAgentMessages';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
  cloudDirectMessageMentions,
} from './cloudDirectMessages';
import { parseCloudGroupControl } from './cloudGroupMessages';
import type { CloudSelfAgentResponseDeliveryState } from './cloudSelfAgentResponseLifecycle';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export type CloudSelfAgentRestoreMessage = {
  message: CloudMessage;
  sessionId: string;
  role: 'user' | 'agent' | 'system';
  messageKind: string;
  text: string;
  createdAtMs: number;
  responseRequestId: string | null;
  responseDeliveryState: CloudSelfAgentResponseDeliveryState | null;
  responseExecution: CloudAgentExecutionSnapshot | undefined;
  messageAction: MessageActionMetadata | null;
  mentions: MessageMention[] | undefined;
  agentRuntimeRoute: ReturnType<typeof cloudAgentRuntimeRouteChangeFromBody>;
};

export function cloudSelfAgentCreatedAtMs(message: CloudMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function cloudSelfAgentRestoreDependencyRank(message: CloudMessage) {
  return parseCloudAgentResponse(message.body) ? 1 : 0;
}

export function isSharedCloudSessionId(sessionId: string): boolean {
  const trimmed = cleanText(sessionId);
  return trimmed.startsWith('session:direct-person:')
    || trimmed.startsWith('session:group:');
}

export function normalizeCloudSelfAgentRestoreMessage(
  message: CloudMessage,
  isGroupControl?: boolean,
): CloudSelfAgentRestoreMessage | null {
  const sessionId = cleanText(message.sessionId);
  if (
    !sessionId
    || sessionId.startsWith('draft:')
    || isSharedCloudSessionId(sessionId)
  ) return null;
  const response = parseCloudAgentResponse(message.body);
  if (
    !response
    && (
      parseCloudAgentCancel(message.body)
      || (isGroupControl ?? Boolean(parseCloudGroupControl(message.body)))
    )
  ) return null;
  const text = cleanText(
    response?.text ?? cloudDirectMessageDisplayText(message.body),
  );
  if (!text) return null;
  const isModelChange = message.messageKind
    === CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND;
  return {
    message,
    sessionId,
    role: response ? 'agent' : isModelChange ? 'system' : 'user',
    messageKind: response
      ? 'agent-turn'
      : isModelChange
        ? CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND
        : 'text',
    text,
    createdAtMs: cloudSelfAgentCreatedAtMs(message),
    responseRequestId: response?.requestId ?? null,
    responseDeliveryState: response
      ? response.deliveryState ?? 'complete'
      : null,
    responseExecution: response?.execution,
    messageAction: response ? null : cloudDirectMessageAction(message.body),
    mentions: response ? undefined : cloudDirectMessageMentions(message.body),
    agentRuntimeRoute: isModelChange
      ? cloudAgentRuntimeRouteChangeFromBody(message.body)
      : null,
  };
}
