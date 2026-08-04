import {
  cancelDesktopChatTurn,
  fetchDesktopChatTurnState,
} from '@/lib/desktop';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import {
  cloudAgentNoProviderNoticeText,
  isCloudAgentNoProviderConfiguredError,
} from './cloudAgentMessages';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  cloudAgentResponseExistsForRequest,
  cloudFallbackRunAlreadyOwnsRequest,
} from './cloudAgentRequestState';
import {
  deriveCloudActivityFromTurn,
  normalizeCloudSessionActivitySnapshot,
  type CloudActivityParticipantProfile,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';

export const CLOUD_AGENT_TURN_POLL_MS = 500;
export const CLOUD_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
export const CLOUD_AGENT_TURN_CANCEL_GRACE_MS = 5_000;
export const CLOUD_AGENT_TURN_TIMEOUT_NOTICE =
  'Kordi took too long to finish this reply. Try again.';

export function cloudAgentLocalFailureMessage(error: unknown): string {
  if (isCloudAgentNoProviderConfiguredError(error)) {
    return cloudAgentNoProviderNoticeText();
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Kordi could not finish this reply. Try again.';
}

export function cloudAgentFailedTurnSnapshot({
  requestId,
  sessionId,
  prompt,
  error,
  now = Date.now(),
}: {
  requestId: string;
  sessionId: string;
  prompt: string;
  error: unknown;
  now?: number;
}): DesktopChatTurnSnapshot {
  const message = cloudAgentLocalFailureMessage(error);
  return {
    id: `cloud-agent-local-failure:${requestId}`,
    sessionId,
    prompt,
    status: 'failed',
    message,
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: false,
    startedAtMs: now,
    completedAtMs: now,
    error: message,
    transcriptRefreshRequired: false,
  };
}

export async function publishDerivedCloudSessionActivity({
  client,
  token,
  accountId,
  sessionId,
  participantAccountIds,
  participantProfiles = [],
  turn,
  mergeActivity,
  reportWarning,
}: {
  client: CloudAuthClient;
  token: string;
  accountId: string;
  sessionId: string;
  participantAccountIds: string[];
  participantProfiles?: CloudActivityParticipantProfile[];
  turn: DesktopChatTurnSnapshot;
  mergeActivity: (snapshot: CloudSessionActivityStore) => void;
  reportWarning?: (message: string, error: unknown) => void;
}) {
  const activity = deriveCloudActivityFromTurn({
    sessionId,
    localAccountId: accountId,
    participantAccountIds: [
      ...new Set(
        [accountId, ...participantAccountIds]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    participantProfiles,
    turn,
  });
  if (activity.tasks.length === 0 && activity.artifacts.length === 0) return;
  const [taskResults, artifactResults] = await Promise.all([
    Promise.allSettled(
      activity.tasks.map((task) => client.upsertTaskActivity(token, task)),
    ),
    Promise.allSettled(
      activity.artifacts.map(
        (artifact) => client.upsertArtifactActivity(token, artifact),
      ),
    ),
  ]);
  const tasks = taskResults
    .filter((
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<CloudAuthClient['upsertTaskActivity']>>
    > => result.status === 'fulfilled')
    .map((result) => result.value);
  const artifacts = artifactResults
    .filter((
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<CloudAuthClient['upsertArtifactActivity']>>
    > => result.status === 'fulfilled')
    .map((result) => result.value);
  if (tasks.length > 0 || artifacts.length > 0) {
    mergeActivity(normalizeCloudSessionActivitySnapshot({ tasks, artifacts }));
  }
  const firstFailure = [...taskResults, ...artifactResults].find(
    (result) => result.status === 'rejected',
  );
  if (firstFailure?.status === 'rejected') {
    reportWarning?.(
      '[cloud-session-activity] publish failed',
      firstFailure.reason,
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function waitForCloudAgentTurn(
  turnId: string,
  onSnapshot?: (snapshot: DesktopChatTurnSnapshot) => void,
) {
  const deadline = Date.now() + CLOUD_AGENT_TURN_TIMEOUT_MS;
  let latest = await fetchDesktopChatTurnState(turnId);
  onSnapshot?.(latest);
  while (!latest.completed && Date.now() < deadline) {
    await wait(CLOUD_AGENT_TURN_POLL_MS);
    latest = await fetchDesktopChatTurnState(turnId);
    onSnapshot?.(latest);
  }
  const timedOut = !latest.completed;
  if (timedOut) {
    await cancelDesktopChatTurn(turnId).catch(() => undefined);
    const cancelDeadline = Date.now() + CLOUD_AGENT_TURN_CANCEL_GRACE_MS;
    while (!latest.completed && Date.now() < cancelDeadline) {
      await wait(CLOUD_AGENT_TURN_POLL_MS);
      latest = await fetchDesktopChatTurnState(turnId);
      onSnapshot?.(latest);
    }
  }
  if (timedOut) {
    latest = {
      ...latest,
      status: 'failed',
      message: CLOUD_AGENT_TURN_TIMEOUT_NOTICE,
      completed: true,
      succeeded: false,
      completedAtMs: Date.now(),
      error: CLOUD_AGENT_TURN_TIMEOUT_NOTICE,
    };
    onSnapshot?.(latest);
  }
  return latest;
}

export async function cloudAgentResponsePublicationIsBlocked({
  client,
  token,
  peerId,
  fallbackMessages,
  account,
  requestMessageId,
}: {
  client: CloudAuthClient;
  token: string;
  peerId: string;
  fallbackMessages: readonly CloudMessage[];
  account: CloudAccount;
  requestMessageId: string;
}): Promise<boolean> {
  const [latestMessages, fallbackRunOwnsRequest] = await Promise.all([
    client.listMessageSnapshot(token, peerId, 100)
      .then((snapshot) => snapshot.messages)
      .catch(() => fallbackMessages),
    cloudFallbackRunAlreadyOwnsRequest({ client, token, requestMessageId }),
  ] as const);
  return fallbackRunOwnsRequest
    || cloudAgentResponseExistsForRequest({
      account,
      requestMessageId,
      peerMessages: latestMessages,
    });
}
