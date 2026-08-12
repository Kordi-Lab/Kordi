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
  const sessions: OpenCanonicalSessionFastResult[] = [];
  for (const request of plan.sessionRequests) {
    if (!shouldContinue()) return null;
    sessions.push(await persistence.openSession(request));
  }
  const messages: CanonicalSessionMessage[] = [];
  for (const request of plan.messageRequests) {
    if (!shouldContinue()) return null;
    messages.push(await persistence.upsertMessage(request));
  }
  const reconciledMessageMirrors: CloudSelfAgentCanonicalSyncPlan['mirrorReconciliations'] = [];
  for (const reconciliation of plan.mirrorReconciliations) {
    if (!shouldContinue()) return null;
    const reconciled = await persistence.reconcileMessageMirror(
      reconciliation.preferredMessageId,
      reconciliation.duplicateMessageId,
    );
    if (reconciled) {
      reconciledMessageMirrors.push(reconciliation);
    }
  }
  return {
    identity,
    sessions,
    messages,
    reconciledMessageMirrors,
  };
}
