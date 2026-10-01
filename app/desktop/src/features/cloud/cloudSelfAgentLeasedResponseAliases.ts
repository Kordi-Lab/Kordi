import type { CanonicalSessionState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { cloudDirectMessageAgentRuntimeRoute } from './cloudDirectMessages';
import { routeRunsOnKordiCloud } from './cloudAgentRuntimeRoute';
import { cloudSelfAgentRequestClientMessageId } from './cloudSelfAgentIdentity';
import type { CloudSelfAgentMirrorReconciliation } from './cloudSelfAgentMirrorPlan';
import type { CloudSelfAgentRestoreMessage } from './cloudSelfAgentRestoreMessage';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function leasedResponseEchoes(
  messages: readonly CloudSelfAgentRestoreMessage[],
  canonicalMessages: CanonicalSessionState['messages'],
) {
  const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]));
  const omittedWireIds = new Set<string>();
  const preferredResponseIdByOriginalWireId = new Map<string, string>();
  const reconciliations: CloudSelfAgentMirrorReconciliation[] = [];
  for (const retained of canonicalMessages) {
    if (retained.sourceTransport !== 'cloud-self-agent'
      || retained.senderRole !== 'owned-agent'
      || retained.messageKind !== 'agent-turn') continue;
    const echo = messages.find((candidate) => (
      candidate.message.messageKind === 'canonical-history-agent'
      && candidate.message.canonicalHistoryLocalMessageId === retained.id
      && candidate.sessionId === retained.sessionId
    ));
    const parent = canonicalById.get(retained.parentMessageId ?? '');
    if (!parent || parent.sessionId !== retained.sessionId || parent.senderRole !== 'user') continue;
    const parentContent = parent.content && typeof parent.content === 'object' && !Array.isArray(parent.content)
      ? parent.content as Record<string, unknown> : {};
    const retainedContent = retained.content && typeof retained.content === 'object' && !Array.isArray(retained.content)
      ? retained.content as Record<string, unknown> : {};
    const originalWireId = parent.sourceTransport === 'cloud-self-agent'
      ? cleanText(parent.sourceEventId)
      : parent.sourceTransport === 'desktop-chat' && typeof parentContent.desktopEntryId === 'string'
        ? cleanText(parentContent.desktopEntryId)
        : parent.sourceTransport === 'desktop-chat-ui'
          ? messages.find((candidate) => (
              candidate.sessionId === retained.sessionId
              && candidate.role === 'user'
              && candidate.message.clientMessageId === cloudSelfAgentRequestClientMessageId(
                retained.sessionId, parent.id,
              )
            ))?.message.messageId
            ?? (routeRunsOnKordiCloud(parentContent.agentRuntimeRoute as DesktopChatMessageRoute | null)
              && retainedContent.execution ? cleanText(retainedContent.cloudRequestMessageId as string) : '')
        : '';
    if (!originalWireId) continue;
    const originalRequest = messages.find((candidate) => (
      candidate.sessionId === retained.sessionId
      && candidate.role === 'user'
      && candidate.message.messageId === originalWireId
    ));
    const provenHostedRequest = originalRequest
      ? routeRunsOnKordiCloud(cloudDirectMessageAgentRuntimeRoute(originalRequest.message.body))
      : parent.sourceTransport === 'cloud-self-agent'
        || parent.sourceTransport === 'desktop-chat'
        || routeRunsOnKordiCloud(parentContent.agentRuntimeRoute as DesktopChatMessageRoute | null);
    if (!provenHostedRequest) continue;
    const originalResponse = messages.find((candidate) => (
      candidate.sessionId === retained.sessionId
      && candidate.message.messageId !== echo?.message.messageId
      && candidate.message.messageKind !== 'canonical-history-agent'
      && candidate.responseRequestId === originalWireId
      && candidate.responseExecution
      && candidate.responseDeliveryState === 'complete'
    ));
    const persistedResponse = canonicalMessages.find((candidate) => {
      const content = candidate.content && typeof candidate.content === 'object' && !Array.isArray(candidate.content)
        ? candidate.content as Record<string, unknown> : {};
      return candidate.sessionId === retained.sessionId
        && candidate.sourceTransport === 'cloud-self-agent'
        && candidate.senderRole === 'owned-agent'
        && candidate.status === 'complete'
        && content.cloudRequestMessageId === originalWireId
        && Boolean(content.execution);
    });
    if (!originalResponse && !persistedResponse) continue;
    const echoWireId = echo?.responseRequestId
      ?? (typeof retainedContent.cloudRequestMessageId === 'string'
        ? retainedContent.cloudRequestMessageId : null);
    if (echoWireId && echoWireId !== originalWireId) omittedWireIds.add(echoWireId);
    if (echo) omittedWireIds.add(echo.message.messageId);
    preferredResponseIdByOriginalWireId.set(originalWireId, retained.id);
    const duplicate = originalResponse
      ? canonicalMessages.find((candidate) => (
          candidate.sessionId === retained.sessionId
          && candidate.sourceTransport === 'cloud-self-agent'
          && candidate.sourceEventId === originalResponse.message.messageId
          && candidate.senderRole === 'owned-agent'
          && candidate.id !== retained.id
        ))
      : persistedResponse?.id !== retained.id ? persistedResponse : null;
    if (duplicate) reconciliations.push({
      preferredMessageId: retained.id, duplicateMessageId: duplicate.id,
    });
  }
  return { omittedWireIds, preferredResponseIdByOriginalWireId, reconciliations };
}
