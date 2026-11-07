import { cloudAgentViewerFailureText } from '@/features/cloud/cloudAgentFailureNotices';
import { cloudAgentFallbackErrorNotice } from '@/features/cloud/cloudAgentMessages';
import { KORDI_SUPPORT_AGENT_ID } from '@/features/support/supportIdentity';
import type { CanonicalSessionMessage } from '@/kordi-app/types';

type FailedTurnMessage = Pick<CanonicalSessionMessage, 'sessionId' | 'sourceTransport' | 'sourceEventId'>;

/**
 * A line written for the requester: a notice their own device wrote, such as
 * an offline owner, or Kordi Support's service line. Neither holds owner detail.
 */
function isRequesterFacingLine(message: FailedTurnMessage): boolean {
  return message.sourceTransport === 'cloud-group-agent-offline'
    || Boolean(message.sourceEventId?.startsWith('cloud-group-agent-offline:'))
    || message.sessionId.endsWith(`:${KORDI_SUPPORT_AGENT_ID}`);
}

/**
 * The error line of a failed agent turn for this viewer. Every member stores
 * the same reply; only the agent's owner sees why it failed.
 */
export function canonicalAgentTurnErrorText(input: {
  message: FailedTurnMessage;
  failureCode: unknown;
  storedError: string;
  legacyCollaborationFailure: boolean;
  viewerOwnsAgent: boolean;
  agentName: string | null | undefined;
}): string {
  const sourceTransport = input.message.sourceTransport?.trim() ?? '';
  const stored = input.legacyCollaborationFailure
    ? 'Message failed'
    : sourceTransport.startsWith('cloud-') || input.storedError.toLowerCase().includes('cloud fallback')
      ? cloudAgentFallbackErrorNotice({ message: input.storedError })
      : input.storedError;
  if (isRequesterFacingLine(input.message)) return stored;
  return cloudAgentViewerFailureText({
    error: stored,
    failureCode: input.failureCode,
    viewerOwnsAgent: input.viewerOwnsAgent,
    agentName: input.agentName,
  });
}
