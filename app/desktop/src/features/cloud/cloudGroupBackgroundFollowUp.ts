import type { MessageActionMetadata } from '@/kordi-app/types/message';
import type { CloudAccount } from './authClient';
import type {
  CloudBackgroundFollowUpReply,
  CloudGroupBackgroundFollowUpRoute,
} from './cloudBackgroundFollowUps';
import type { CloudGroupAgentPolicy } from './cloudGroupAgentControl.types';
import type {
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';
import { publishCloudGroupAgentTerminalAfterGuards } from './cloudGroupAgentPublication';

/**
 * The route a group request registers for its background follow-ups. It keeps
 * only what the reply needs: the group, its participants, the thread and the
 * agent identity. The request's text and attachments stay out.
 */
export function cloudGroupBackgroundFollowUpRoute({
  context,
  messageAction,
  targetAccountIds,
  agentId,
  agentDisplayName,
}: {
  context: Pick<CloudGroupMessageControlContext, 'account' | 'envelope' | 'groupSpaceId' | 'participantByAccount'>;
  messageAction: MessageActionMetadata | null;
  targetAccountIds: string[];
  agentId: string;
  agentDisplayName: string;
}): CloudGroupBackgroundFollowUpRoute | null {
  const { envelope } = context;
  const message = envelope.message;
  if (!message) return null;
  const {
    text: _text,
    attachments: _attachments,
    voiceMessage: _voiceMessage,
    mentions: _mentions,
    messageAction: _messageAction,
    ...requestMessage
  } = message;
  return {
    kind: 'group',
    accountId: context.account.accountId,
    envelope: {
      kind: envelope.kind,
      groupId: envelope.groupId,
      groupSpaceId: envelope.groupSpaceId ?? null,
      groupTitle: null,
      createdByAccountId: envelope.createdByAccountId,
      actor: envelope.actor,
      participants: envelope.participants,
      message: { ...requestMessage, text: '', ...(messageAction ? { messageAction } : {}) },
    },
    groupSpaceId: context.groupSpaceId,
    participants: [...context.participantByAccount.values()],
    targetAccountIds,
    agentId,
    agentDisplayName,
  };
}

/** Sends a background follow-up reply into the group, in the request's thread. */
export async function publishCloudGroupBackgroundFollowUp(
  {
    account,
    runtime,
    policy,
    token,
  }: {
    account: CloudAccount;
    runtime: CloudGroupAgentRuntime;
    policy: CloudGroupAgentPolicy;
    token: string;
  },
  route: CloudGroupBackgroundFollowUpRoute,
  reply: CloudBackgroundFollowUpReply,
): Promise<void> {
  const context = {
    account,
    envelope: route.envelope,
    groupSpaceId: route.groupSpaceId,
    participantByAccount: new Map(route.participants.map((participant) => [participant.accountId, participant])),
  };
  await publishCloudGroupAgentTerminalAfterGuards({
    // An explicit publisher skips the request-ownership guard: this Mac ran
    // the parent turn. It also gives the reply a stable client message id.
    publisher: runtime.client,
    // Only these context fields are read when a publisher is given.
    context: context as CloudGroupMessageControlContext,
    runtime,
    policy,
    token,
    targetAccountIds: route.targetAccountIds,
    responseMessageId: `msg:cloud-agent:${reply.turn.id}`,
    responseCreatedAtMs: reply.turn.completedAtMs ?? Date.now(),
    responseText: reply.text,
    responseDeliveryState: reply.deliveryState === 'complete' ? 'complete' : 'failed',
    responseTools: [],
    responseTiming: reply.turn,
    requestId: reply.requestId,
    agentId: route.agentId,
    agentDisplayName: route.agentDisplayName,
    agentHandoff: null,
    signal: new AbortController().signal,
  });
}
