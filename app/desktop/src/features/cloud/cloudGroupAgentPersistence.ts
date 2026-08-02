import {
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import type { AppendCanonicalMessageRequest } from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import { cloudGroupAgentConversationId } from './cloudGroupMessages';
import type {
  ApplyCloudGroupAgentControlInput,
  CloudGroupAgentPresentation,
} from './cloudGroupAgentControl.types';

function cloudGroupAgentPresentation(
  input: ApplyCloudGroupAgentControlInput,
): CloudGroupAgentPresentation {
  const { account, envelope } = input.context;
  const message = envelope.message!;
  const hostedAgentName = input.stateOps.cleanText(
    message.targetCloudAgentName,
  );
  const hostedAgentOwnerName = input.stateOps.cleanText(
    message.targetCloudAgentOwnerName,
  )
    || input.stateOps.cleanText(account.displayName)
    || input.stateOps.cleanText(account.primaryEmail)
    || 'Cloud user';
  return {
    identityId: `agent:cloud:${account.accountId}`,
    displayName: hostedAgentName || `${hostedAgentOwnerName}'s Kordi`,
  };
}

export async function ensureCloudGroupAgentIdentity(
  input: ApplyCloudGroupAgentControlInput,
  signal?: AbortSignal,
): Promise<CloudGroupAgentPresentation> {
  const { account, localHumanIdentityId } = input.context;
  const presentation = cloudGroupAgentPresentation(input);
  const agentIdentity = await upsertCanonicalIdentityFast({
    id: presentation.identityId,
    kind: 'agent',
    displayName: presentation.displayName,
    ownerIdentityId: localHumanIdentityId,
    source: 'local',
    sourceHostId: 'cloud',
    sourceIdentityId: `cloud-agent:${account.accountId}`,
    humanId: account.accountId,
    agentId: `cloud-agent:${account.accountId}`,
    avatarKey: `cloud-agent:${account.accountId}`,
    profileImageUrl: null,
    metadata: { accountId: account.accountId, cloudGroupAgent: true },
  });
  if (!signal?.aborted) {
    input.setCanonicalState((current) =>
      input.stateOps.upsertIdentity(current, agentIdentity)
    );
  }
  return presentation;
}

export async function persistQueuedCloudGroupAgentTurn(
  input: ApplyCloudGroupAgentControlInput,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const { account, envelope } = input.context;
  const message = envelope.message!;
  const presentation = await ensureCloudGroupAgentIdentity(input, signal);
  if (signal?.aborted) return;
  const createdAtMs = Date.now();
  const queuedMessageId =
    `msg:cloud-agent-processing:${message.id}:${account.accountId}`;
  const persistedQueuedMessage = await upsertCanonicalMessageFast({
    id: queuedMessageId,
    sessionId: envelope.groupId,
    senderIdentityId: presentation.identityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'queued...',
    content: {
      sender: presentation.displayName,
      timestampMs: createdAtMs,
      deliveryState: 'queued',
      sourceConversationId: cloudGroupAgentConversationId(envelope.groupId),
      requestId: message.id,
      replyToMessageId: message.id,
    },
    createdAtMs,
    parentMessageId: message.id,
    status: 'queued',
    sourceTransport: 'cloud-group-agent',
    sourceEventId: `cloud-group-agent:${queuedMessageId}`,
  } satisfies AppendCanonicalMessageRequest);
  if (signal?.aborted) return;
  input.setCanonicalState((current) =>
    mergeCanonicalMessageRow(current, persistedQueuedMessage)
  );
}
