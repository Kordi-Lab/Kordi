import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudAgentRunStatus, CloudMessage } from './authClient';
import { parseCloudAgentResponse } from './cloudAgentMessages';
import { upsertCanonicalRequestIntoLocalState } from './cloudAgentRequestState';
import { indexLocalSelfAgentMessagesByClientMessageId } from './cloudSelfAgentMirrorPlan';

const PROGRESS_SOURCE = 'cloud-self-agent-progress';

export function hostedSelfAgentProgressId(requestMessageId: string) {
  return `msg:cloud:self:progress:${requestMessageId}`;
}

export function hostedSelfAgentRequestIsTerminal(
  requestMessageId: string,
  messages: readonly CloudMessage[],
) {
  return messages.some((message) => {
    const response = parseCloudAgentResponse(message.body);
    return response?.requestId === requestMessageId
      && response.deliveryState !== 'processing';
  });
}

export function removeHostedSelfAgentProgress(
  state: CanonicalSessionState | null,
  requestMessageId: string,
): CanonicalSessionState | null {
  if (!state) return state;
  const id = hostedSelfAgentProgressId(requestMessageId);
  const messages = state.messages.filter((message) => (
    message.id !== id || message.sourceTransport !== PROGRESS_SOURCE
  ));
  return messages.length === state.messages.length ? state : { ...state, messages };
}

export function updateHostedSelfAgentProgress(
  state: CanonicalSessionState | null,
  input: {
    request: CloudMessage;
    runStatus: CloudAgentRunStatus;
    cloudMessages: readonly CloudMessage[];
  },
): CanonicalSessionState | null {
  if (!state) return state;
  const requestId = input.request.messageId;
  const status = input.runStatus.trim().toLowerCase();
  if (
    !['queued', 'leased', 'running'].includes(status)
    || hostedSelfAgentRequestIsTerminal(requestId, input.cloudMessages)
    || state.messages.some((message) => {
      if (
        message.senderRole !== 'owned-agent'
        || message.messageKind !== 'agent-turn'
        || message.sourceTransport === PROGRESS_SOURCE
      ) return false;
      const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
        ? message.content as Record<string, unknown> : {};
      return content.cloudRequestMessageId === requestId;
    })
  ) return removeHostedSelfAgentProgress(state, requestId);

  const clientMessageId = input.request.clientMessageId?.trim();
  if (!clientMessageId) return state;
  const localRequest = indexLocalSelfAgentMessagesByClientMessageId(state.messages).get(clientMessageId);
  if (!localRequest || localRequest.sessionId !== input.request.sessionId) return state;
  const session = state.sessions.find((candidate) => candidate.id === localRequest.sessionId);
  const agentIdentityId = session?.primaryIdentityId?.trim();
  if (!agentIdentityId) return state;
  const id = hostedSelfAgentProgressId(requestId);
  const existing = state.messages.find((message) => message.id === id);
  if (existing?.sourceTransport === PROGRESS_SOURCE) {
    const content = existing.content && typeof existing.content === 'object' && !Array.isArray(existing.content)
      ? existing.content as Record<string, unknown> : {};
    if (content.hostedRunStatus === status) return state;
  }
  return upsertCanonicalRequestIntoLocalState(state, {
    id,
    sessionId: localRequest.sessionId,
    senderIdentityId: agentIdentityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      cloudRequestMessageId: requestId,
      requestId: localRequest.id,
      replyToMessageId: localRequest.id,
      deliveryState: status === 'running' ? 'processing' : 'queued',
      hostedRunStatus: status,
    },
    parentMessageId: localRequest.id,
    status: status === 'running' ? 'processing' : 'queued',
    createdAtMs: localRequest.createdAtMs + 1,
    sourceTransport: PROGRESS_SOURCE,
    sourceEventId: requestId,
  });
}
