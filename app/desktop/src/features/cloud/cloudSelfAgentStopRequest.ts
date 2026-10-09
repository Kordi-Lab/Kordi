import type { CloudAccount, CloudAuthClient } from './authClient';
import { cloudMessageIsSelfAgentRequest, parseCloudAgentResponse } from './cloudAgentMessages';
import { CloudAuthError } from './cloudAuthError';
import { closeCloudAgentRunFromDesktop } from './cloudInterruptedTurnRelease';
import { cloudSelfAgentHasTerminalResponse } from './cloudSelfAgentExecutionState';
import type { CloudSelfAgentActiveRequest } from './cloudSelfAgentRequestExecution';
import { cloudSelfAgentStoppedReply } from './cloudSelfAgentTerminalReply';
import { loadSession } from './session';
import type { CloudSelfAgentExecutionInput } from './useDesktopAgentReadiness';

/** The text of the latest processing reply to `requestId`, as other devices saw it. */
function latestCloudSelfAgentProcessingText(
  requestId: string,
  messages: readonly { body: string; createdAt: string }[],
): string {
  let latest: { text: string; atMs: number } | null = null;
  for (const message of messages) {
    const response = parseCloudAgentResponse(message.body);
    if (response?.requestId !== requestId || response.deliveryState !== 'processing') continue;
    const atMs = Date.parse(message.createdAt) || 0;
    if (response.text.trim() && (!latest || atMs >= latest.atMs)) latest = { text: response.text, atMs };
  }
  return latest?.text ?? '';
}

/**
 * Stops the session's running request. A request this Mac executes stops
 * here. A request whose local turn is already gone, such as after a lost
 * lease, is ended through this device's run with the text it streamed.
 * Another executor learns of the stop from the server.
 */
export async function stopCloudSelfAgentRequest({
  sessionId,
  activeRequests,
  supersededRequestIds,
  streamedTextByRequestId,
  latest,
}: {
  sessionId: string;
  activeRequests: ReadonlyMap<string, CloudSelfAgentActiveRequest>;
  supersededRequestIds: Set<string>;
  streamedTextByRequestId: ReadonlyMap<string, string>;
  latest: {
    account: CloudAccount | null;
    client: CloudAuthClient;
    messageIndex: CloudSelfAgentExecutionInput['messageIndex'];
    setLocalTurns: CloudSelfAgentExecutionInput['setLocalTurns'];
    syncMessages: () => Promise<void>;
    reportWarning: (message: string, error: unknown) => void;
  };
}): Promise<boolean> {
  for (const active of activeRequests.values()) {
    if (active.sessionId !== sessionId) continue;
    active.stop();
    return true;
  }
  const {
    account: currentAccount,
    client: currentClient,
    messageIndex: currentIndex,
    setLocalTurns: setCurrentLocalTurns,
    syncMessages: syncCurrentMessages,
    reportWarning: reportCurrentWarning,
  } = latest;
  if (!currentAccount) return false;
  const selfMessages = currentIndex.byPeerId.get(currentAccount.accountId) ?? [];
  // Oldest first: the running request precedes the ones queued behind it.
  // The server reports requests that already ended, so try the next one.
  const pending = selfMessages
    .filter((message) => (
      message.sessionId === sessionId
      && cloudMessageIsSelfAgentRequest(message, currentAccount)
      && !cloudSelfAgentHasTerminalResponse(message.messageId, selfMessages)
    ))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  if (pending.length === 0) return false;
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  for (const request of pending) {
    const reply = cloudSelfAgentStoppedReply(
      streamedTextByRequestId.get(request.messageId)
        || latestCloudSelfAgentProcessingText(request.messageId, selfMessages),
    );
    // This device's own run needs no live turn or lease to end.
    const closure = await closeCloudAgentRunFromDesktop(currentClient, session.token, {
      sessionId,
      requestId: request.messageId,
      state: 'cancelled',
      text: reply.text,
      ending: reply.ending,
    }).catch((error: unknown) => {
      if (!(error instanceof CloudAuthError) || ![404, 409].includes(error.status)) {
        reportCurrentWarning('[cloud-self-agent-execution] run close failed', error);
      }
      return null;
    });
    if (closure?.closed || closure?.published) {
      supersededRequestIds.add(request.messageId);
      setCurrentLocalTurns((current) => {
        if (!current[request.messageId]) return current;
        const { [request.messageId]: _stopped, ...rest } = current;
        return rest;
      });
      await syncCurrentMessages().catch((error) => reportCurrentWarning(
        '[cloud-self-agent-execution] terminal sync failed',
        error,
      ));
      return true;
    }
    try {
      await currentClient.stopCloudAgentRequest(session.token, request.messageId);
      return true;
    } catch (error) {
      if (!(error instanceof CloudAuthError) || ![404, 409].includes(error.status)) throw error;
    }
  }
  return false;
}
