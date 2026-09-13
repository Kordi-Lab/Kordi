import type { CanonicalSessionState, UpsertCanonicalIdentityRequest } from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import type { CloudSelfAgentCanonicalSyncPlan } from './cloudSelfAgentCanonicalSync';
import { cloudAgentSessionTargetFromMessages } from './cloudSelfAgentSessionIdentity';
import { defaultCloudAgentId } from './cloudAgentIdentity';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : {};

// A self-addressed transport identifies the owner, not which of their Agents
// answered. Restore the explicit target before persisting session/message IDs.
export function applyCloudSelfAgentTargetIdentities(
  plan: CloudSelfAgentCanonicalSyncPlan,
  account: CloudAccount,
  messages: readonly CloudMessage[],
  state: CanonicalSessionState,
): CloudSelfAgentCanonicalSyncPlan {
  const bySession = new Map<string, CloudMessage[]>();
  for (const message of messages) {
    const sessionId = message.sessionId?.trim();
    if (!sessionId || message.fromAccountId !== account.accountId || message.toAccountId !== account.accountId) continue;
    const entries = bySession.get(sessionId) ?? [];
    entries.push(message);
    bySession.set(sessionId, entries);
  }
  const identities = new Map<string, UpsertCanonicalIdentityRequest>();
  const sessions = new Map(plan.sessionRequests.map(request => [request.id, request]));
  const requests = new Map(plan.messageRequests.map(request => [request.id, request]));
  const existingBySession = new Map<string, typeof state.messages>();
  for (const message of state.messages) {
    const entries = existingBySession.get(message.sessionId) ?? [];
    entries.push(message);
    existingBySession.set(message.sessionId, entries);
  }
  const plannedBySession = new Map<string, typeof plan.messageRequests>();
  for (const request of plan.messageRequests) {
    const entries = plannedBySession.get(request.sessionId) ?? [];
    entries.push(request);
    plannedBySession.set(request.sessionId, entries);
  }
  const ownerIdentityId = state.profile.humanIdentityId || `human:${account.accountId}`;
  for (const [sessionId, entries] of bySession) {
    const target = cloudAgentSessionTargetFromMessages(entries, account.accountId);
    if (!target || target.targetCloudAgentId === defaultCloudAgentId(account.accountId)) continue;
    const existingIdentity = state.identities.find(identity => identity.kind === 'agent'
      && identity.agentId === target.targetCloudAgentId && identity.ownerIdentityId === ownerIdentityId);
    const displayName = existingIdentity?.displayName || target.targetCloudAgentName;
    if (!displayName) continue;
    const identityId = existingIdentity?.id ?? `agent:cloud-owned:${target.targetCloudAgentId}`;
    if (!existingIdentity) identities.set(identityId, {
      id: identityId, kind: 'agent', displayName, ownerIdentityId, source: 'local',
      agentId: target.targetCloudAgentId, avatarKey: target.targetCloudAgentId,
      metadata: { isOwned: true, accountId: account.accountId, agentId: target.targetCloudAgentId },
    });
    const existing = state.sessions.find(session => session.id === sessionId);
    const planned = sessions.get(sessionId);
    const metadata = {
      ...record(existing?.metadata), ...record(planned?.metadata),
      cloudSelfAgentSession: true, cloudSelfAgentTarget: true,
      cloudAgentId: target.targetCloudAgentId, cloudAgentName: displayName,
    };
    if (planned || !existing || existing.primaryIdentityId !== identityId
      || existing.kind !== 'direct-agent' || record(existing.metadata).cloudSelfAgentTarget !== true) {
      sessions.set(sessionId, {
        ...planned, id: sessionId, kind: 'direct-agent',
        title: planned?.title || existing?.title || 'New chat', status: existing?.status || 'active',
        createdByIdentityId: ownerIdentityId, primaryIdentityId: identityId,
        participantIdentityIds: [identityId], metadata,
      });
    }
    for (const message of existingBySession.get(sessionId) ?? []) {
      if (message.senderRole !== 'owned-agent'
        || message.sourceTransport === 'canonical-fork-snapshot'
        || requests.has(message.id) || message.senderIdentityId === identityId) continue;
      requests.set(message.id, {
        id: message.id, sessionId, senderIdentityId: identityId, senderRole: message.senderRole,
        messageKind: message.messageKind, contentText: message.contentText,
        content: { ...record(message.content), sender: null }, parentMessageId: message.parentMessageId,
        status: message.status, createdAtMs: message.createdAtMs,
        sourceTransport: message.sourceTransport, sourceEventId: message.sourceEventId,
      });
    }
    for (const request of plannedBySession.get(sessionId) ?? []) {
      if (request.senderRole !== 'owned-agent'
        || request.sourceTransport === 'canonical-fork-snapshot') continue;
      requests.set(request.id, { ...request, senderIdentityId: identityId,
        content: { ...record(request.content), sender: null } });
    }
  }
  return { ...plan, targetIdentityRequests: [...identities.values()],
    sessionRequests: [...sessions.values()], messageRequests: [...requests.values()] };
}
