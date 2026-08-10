import {
  openOrCreateCanonicalSessionFast,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
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
import { applyCanonicalSelfAgentSyncPlan } from './cloudSelfAgentDesktopPersistence';

export type CloudSelfAgentCanonicalPersistence = {
  applyPlan?: (
    plan: CloudSelfAgentCanonicalSyncPlan,
  ) => Promise<CloudSelfAgentCanonicalSyncBatch>;
  upsertIdentity: (
    request: UpsertCanonicalIdentityRequest,
  ) => Promise<CanonicalIdentity>;
  openSession: (
    request: OpenCanonicalSessionRequest,
  ) => Promise<OpenCanonicalSessionFastResult>;
  upsertMessage: (
    request: AppendCanonicalMessageRequest,
  ) => Promise<CanonicalSessionMessage>;
};

const desktopPersistence: CloudSelfAgentCanonicalPersistence = {
  applyPlan: applyCanonicalSelfAgentSyncPlan,
  upsertIdentity: upsertCanonicalIdentityFast,
  openSession: openOrCreateCanonicalSessionFast,
  upsertMessage: upsertCanonicalMessageFast,
};

export function cloudSelfAgentCanonicalSyncPlanSignature(
  plan: CloudSelfAgentCanonicalSyncPlan,
) {
  return JSON.stringify([
    plan.agentIdentityRequest,
    plan.sessionRequests,
    plan.messageRequests,
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
  if (persistence.applyPlan) {
    return persistence.applyPlan(plan);
  }
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
  return { identity, sessions, messages };
}
