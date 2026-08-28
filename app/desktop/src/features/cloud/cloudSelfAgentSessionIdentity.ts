import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudAuthClient, CloudMessage } from './authClient';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from './cloudAgentMessages';
import {
  CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND,
  cloudDirectMessageTargetCloudAgentId,
  cloudDirectMessageTargetCloudAgentName,
  cloudDirectMessageTargetCloudAgentOwnerAccountId,
  encodeCloudDirectMessageEnvelope,
} from './cloudDirectMessages';
import { compareCloudMessages } from './cloudMessageMerge';
import { cloudOperationUuid } from './chatSyncMapping';

type IdentityLedger = Record<string, {
  cloudMessageId: string | null;
  syncedAtMs: number;
}>;

type IdentityPlan = {
  sessionId: string;
  targetAgentId?: string;
  targetAgentName?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function cloudSelfAgentIdentityLedgerKey(sessionId: string) {
  return `agent-identity:${sessionId}`;
}

export function cloudAgentSessionTargetFromMessages(
  messages: readonly CloudMessage[],
  ownerAccountId: string,
  beforeMessage?: CloudMessage,
) {
  const sessionId = beforeMessage?.sessionId?.trim();
  const targetNamesById = new Map<string, string>();
  let target: { targetCloudAgentId: string; targetCloudAgentName: string | null } | null = null;
  for (const message of [...messages].sort(compareCloudMessages)) {
    if (sessionId && message.sessionId?.trim() !== sessionId) continue;
    if (beforeMessage && compareCloudMessages(message, beforeMessage) > 0) break;
    const targetCloudAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
    if (
      !targetCloudAgentId
      || cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body) !== ownerAccountId
    ) continue;
    const messageTargetName = cloudDirectMessageTargetCloudAgentName(message.body);
    if (messageTargetName) targetNamesById.set(targetCloudAgentId, messageTargetName);
    const targetCloudAgentName = targetNamesById.get(targetCloudAgentId) ?? null;
    target = { targetCloudAgentId, targetCloudAgentName };
  }
  return target;
}

export function cloudSyncedLocalAgentSessionIds(state: CanonicalSessionState) {
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  return new Set(state.sessions.filter((session) => (
    !session.id.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX)
    && (session.kind === 'self-agent' || (
      session.kind === 'direct-agent'
      && text(record(session.metadata).createdFrom) === 'chat-create-flow'
      && record(identityById.get(session.primaryIdentityId?.trim() ?? '')?.metadata).isOwned === true
    ))
  )).map((session) => session.id));
}

export function cloudAgentTargetsBySessionId(
  state: CanonicalSessionState,
  sessionIds: ReadonlySet<string>,
) {
  const sessionById = new Map(state.sessions.map((session) => [session.id, session]));
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  const targets = new Map<string, { targetAgentId: string; targetAgentName: string }>();
  for (const sessionId of sessionIds) {
    const session = sessionById.get(sessionId);
    const primaryIdentityId = session?.primaryIdentityId?.trim() ?? '';
    const identity = identityById.get(primaryIdentityId);
    const metadata = record(session?.metadata);
    const identityMetadata = record(identity?.metadata);
    const targetAgentId = text(metadata.cloudAgentId) || text(identity?.agentId) || text(identityMetadata.agentId);
    const targetAgentName = text(metadata.cloudAgentName) || text(identity?.displayName);
    const isDefaultAgent = primaryIdentityId === state.profile.activeAgentIdentityId && !text(metadata.cloudAgentId);
    if (!isDefaultAgent && targetAgentId && targetAgentName) {
      targets.set(sessionId, { targetAgentId, targetAgentName });
    }
  }
  return targets;
}

export function cloudAgentIdentitySyncedSessionIds(
  state: CanonicalSessionState,
  ledger: IdentityLedger,
) {
  return new Set<string>(state.sessions
    .filter((session) => ledger[cloudSelfAgentIdentityLedgerKey(session.id)])
    .map((session) => session.id));
}

export async function publishCloudAgentIdentityMarkers({
  accountId,
  client,
  ledger,
  plans,
  remoteMessages = [],
  token,
}: {
  accountId: string;
  client: Pick<CloudAuthClient, 'sendMessage'>;
  ledger: IdentityLedger;
  plans: readonly IdentityPlan[];
  remoteMessages?: readonly {
    id: string;
    client_message_id: string;
  }[];
  token: string;
}) {
  const nextLedger = { ...ledger };
  const remoteByClientMessageId = new Map(remoteMessages.map((message) => [
    message.client_message_id,
    message,
  ]));
  let changed = false;
  for (const plan of plans) {
    if (!plan.targetAgentId || !plan.targetAgentName) continue;
    const ledgerKey = cloudSelfAgentIdentityLedgerKey(plan.sessionId);
    if (nextLedger[ledgerKey]) continue;
    const clientMessageId = `self-agent:${plan.sessionId}:agent-identity`;
    const remote = remoteByClientMessageId.get(
      cloudOperationUuid(clientMessageId),
    );
    if (remote) {
      nextLedger[ledgerKey] = {
        cloudMessageId: remote.id,
        syncedAtMs: Date.now(),
      };
      changed = true;
      continue;
    }
    const marker = await client.sendMessage(token, accountId, encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: '',
      targetCloudAgentId: plan.targetAgentId,
      targetCloudAgentName: plan.targetAgentName,
      targetCloudAgentOwnerAccountId: accountId,
    }), {
      sessionId: plan.sessionId,
      clientMessageId,
      messageKind: CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND,
    });
    nextLedger[ledgerKey] = { cloudMessageId: marker.messageId, syncedAtMs: Date.now() };
    changed = true;
  }
  return { changed, ledger: nextLedger };
}
