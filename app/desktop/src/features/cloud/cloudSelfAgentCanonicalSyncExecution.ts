import {
  openOrCreateCanonicalSessionFast,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import { reconcileCanonicalMessageMirror } from '@/lib/desktopCanonicalMirror';
import type {
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSessionMessage,
  OpenCanonicalSessionFastResult,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import type { CloudSelfAgentCanonicalSyncBatch } from './cloudCanonicalStateMerge';
import type { CloudSelfAgentCanonicalSyncPlan } from './cloudSelfAgentCanonicalSync';

export type CloudSelfAgentCanonicalPersistence = {
  upsertIdentity: (
    request: UpsertCanonicalIdentityRequest,
  ) => Promise<CanonicalIdentity>;
  openSession: (
    request: OpenCanonicalSessionRequest,
  ) => Promise<OpenCanonicalSessionFastResult>;
  upsertMessage: (
    request: AppendCanonicalMessageRequest,
  ) => Promise<CanonicalSessionMessage>;
  reconcileMessageMirror: (
    preferredMessageId: string,
    duplicateMessageId: string,
  ) => Promise<boolean>;
};

const desktopPersistence: CloudSelfAgentCanonicalPersistence = {
  upsertIdentity: upsertCanonicalIdentityFast,
  openSession: openOrCreateCanonicalSessionFast,
  upsertMessage: upsertCanonicalMessageFast,
  reconcileMessageMirror: reconcileCanonicalMessageMirror,
};

export function cloudSelfAgentCanonicalSyncPlanSignature(
  plan: CloudSelfAgentCanonicalSyncPlan,
) {
  return JSON.stringify([
    plan.agentIdentityRequest,
    plan.targetIdentityRequests,
    plan.sessionRequests,
    plan.messageRequests,
    plan.mirrorReconciliations,
  ]);
}

export async function persistCloudSelfAgentCanonicalSyncPlan(
  plan: CloudSelfAgentCanonicalSyncPlan,
  {
    persistence = desktopPersistence,
    shouldContinue = () => true,
  }: {
    persistence?: CloudSelfAgentCanonicalPersistence;
    shouldContinue?: () => boolean;
  } = {},
): Promise<CloudSelfAgentCanonicalSyncBatch | null> {
  if (!shouldContinue()) return null;
  const identity = await persistence.upsertIdentity(
    plan.agentIdentityRequest,
  );
  const targetIdentities: CanonicalIdentity[] = [];
  for (const request of plan.targetIdentityRequests ?? []) {
    if (!shouldContinue()) return null;
    targetIdentities.push(await persistence.upsertIdentity(request));
  }
  const sessions: OpenCanonicalSessionFastResult[] = [];
  for (const request of plan.sessionRequests) {
    if (!shouldContinue()) return null;
    sessions.push(await persistence.openSession(request));
  }
  const reconciledMessageMirrors: CloudSelfAgentCanonicalSyncPlan['mirrorReconciliations'] = [];
  for (const reconciliation of plan.mirrorReconciliations) {
    if (!shouldContinue()) return null;
    // A pair the store refuses stays two rows; it must not stop the batch,
    // or no later Cloud update (such as a run's progress) is ever stored.
    const reconciled = await persistence.reconcileMessageMirror(
      reconciliation.preferredMessageId,
      reconciliation.duplicateMessageId,
    ).catch(() => false);
    if (reconciled) {
      reconciledMessageMirrors.push(reconciliation);
    }
  }
  // Reconcile while the preferred row still has its local provenance. The
  // terminal Cloud upsert below may intentionally attach the Cloud source
  // event to that same row after the processing mirror has been removed.
  const messages: CanonicalSessionMessage[] = [];
  for (const request of plan.messageRequests) {
    if (!shouldContinue()) return null;
    messages.push(await persistence.upsertMessage(request));
  }
  return {
    identity, ...(targetIdentities.length ? { targetIdentities } : {}),
    sessions,
    messages,
    reconciledMessageMirrors,
  };
}

function sameStoredMessage(row: CanonicalSessionMessage, request: AppendCanonicalMessageRequest) {
  return row.sessionId === request.sessionId
    && row.senderIdentityId === request.senderIdentityId
    && row.senderRole === request.senderRole
    && row.messageKind === request.messageKind
    && row.contentText === request.contentText
    && (row.parentMessageId ?? null) === (request.parentMessageId ?? null)
    && row.status === (request.status ?? row.status)
    && (request.createdAtMs == null || row.createdAtMs === request.createdAtMs)
    && (row.sourceTransport ?? null) === (request.sourceTransport ?? null)
    && (row.sourceEventId ?? null) === (request.sourceEventId ?? null)
    && JSON.stringify(row.content ?? null) === JSON.stringify(request.content ?? null);
}

/**
 * Drops message writes that would store a row exactly as it is. The plan
 * covers every Ask Agent message, so without this each new message rewrote
 * hundreds of unchanged rows one by one, and a run's progress and final reply
 * reached the transcript seconds late.
 */
export function withoutStoredMessageRequests(
  plan: CloudSelfAgentCanonicalSyncPlan,
  messages: readonly CanonicalSessionMessage[],
): CloudSelfAgentCanonicalSyncPlan {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const reconciled = new Set(plan.mirrorReconciliations.flatMap((item) => [item.preferredMessageId, item.duplicateMessageId]));
  const messageRequests = plan.messageRequests.filter((request) => {
    const row = request.id ? byId.get(request.id) : undefined;
    return !row || reconciled.has(row.id) || !sameStoredMessage(row, request);
  });
  return messageRequests.length === plan.messageRequests.length ? plan : { ...plan, messageRequests };
}
