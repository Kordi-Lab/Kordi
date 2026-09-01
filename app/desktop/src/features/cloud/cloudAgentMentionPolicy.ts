import {
  compatibleSourceHostId,
  normalizeCollaborationTargetKind,
} from '@/features/collaboration/legacyBridgeCompatibility';
import type {
  CanonicalIdentity,
  CanonicalSessionState,
} from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import {
  cloudMessageMentionsLocalAgent,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetsOwnedHostedCloudAgent,
  parseCloudDirectMessageEnvelope,
} from './cloudDirectMessages';
import { cloudMessageActionAllowsAgentTrigger } from './cloudAgentTriggerPolicy';
import { parseCloudGroupControl } from './cloudGroupMessages';
import {
  cloudAgentResponseExistsForRequest,
  type CloudAgentRequestCandidate,
} from './cloudAgentRequestState';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';
import { defaultCloudAgentId } from './cloudAgentIdentity';

export const CLOUD_AGENT_MENTION_WINDOW_MS = 10 * 60_000;

type CloudAgentMentionCandidateOptions = {
  /** Lower bound (inclusive) on `createdAtMs` — older messages are skipped. */
  recentSinceMs?: number;
  /**
   * Message IDs kept even outside `recentSinceMs`. This lets an existing
   * requesting/offline timer reconcile its original request.
   */
  keepStaleIds?: ReadonlySet<string>;
};

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function cloudAgentMentionCandidates(
  state: CanonicalSessionState,
  accountId: string,
  options: CloudAgentMentionCandidateOptions = {},
): CloudAgentRequestCandidate[] {
  const { recentSinceMs, keepStaleIds } = options;
  const identityByHumanId = new Map<string, CanonicalIdentity>();
  const identityById = new Map(
    state.identities.map((identity) => [identity.id, identity]),
  );
  for (const identity of state.identities) {
    const humanId = cleanText(identity.humanId)
      || cleanText(identity.sourceIdentityId);
    if (identity.kind === 'human' && humanId) {
      identityByHumanId.set(humanId, identity);
    }
  }

  return state.messages.flatMap((message): CloudAgentRequestCandidate[] => {
    if (message.sourceTransport === 'canonical-fork-snapshot') return [];
    if (message.senderRole !== 'user' || message.status === 'failed') return [];
    if (message.sessionId.trim().startsWith('session:direct-person:')) return [];
    if (
      recentSinceMs !== undefined
      && message.createdAtMs < recentSinceMs
      && !keepStaleIds?.has(message.id)
    ) return [];
    const content = objectContent(message.content);
    const mentions = Array.isArray(content.mentions) ? content.mentions : [];
    return mentions.flatMap((rawMention): CloudAgentRequestCandidate[] => {
      const mention = objectContent(rawMention);
      if (normalizeCollaborationTargetKind(mention.targetKind) !== 'agent') {
        return [];
      }
      if (cleanText(compatibleSourceHostId(mention)) !== CLOUD_HOST_SENTINEL) {
        return [];
      }
      const targetAccountId = cleanText(
        typeof mention.humanId === 'string' ? mention.humanId : null,
      ) || cleanText(
        typeof mention.nodeId === 'string' ? mention.nodeId : null,
      );
      const mentionAgentId = cleanText(
        typeof mention.agentId === 'string' ? mention.agentId : null,
      );
      const targetCloudAgentId = mentionAgentId.startsWith('cloud_agent_')
        ? mentionAgentId
        : null;
      if (
        !targetAccountId
        || (targetAccountId === accountId && !targetCloudAgentId)
      ) return [];
      const humanIdentity = identityByHumanId.get(targetAccountId);
      const agentIdentity = identityById.get(`agent:cloud:${targetAccountId}`);
      const targetHumanDisplayName = cleanText(humanIdentity?.displayName)
        || cleanText(
          typeof mention.ownerName === 'string' ? mention.ownerName : null,
        )
        || cleanText(
          typeof mention.label === 'string'
            ? mention.label.replace(/'?sKordi$/u, '')
            : null,
        )
        || targetAccountId;
      const targetAgentDisplayName = targetCloudAgentId
        ? cleanText(
          typeof mention.displayLabel === 'string'
            ? mention.displayLabel
            : null,
        )
          || cleanText(
            typeof mention.label === 'string' ? mention.label : null,
          )
          || 'Shared Agent'
        : cleanText(agentIdentity?.displayName)
          || 'Kordi';
      return [{
        requestMessage: message,
        targetAccountId,
        targetHumanDisplayName,
        targetAgentDisplayName,
        targetCloudAgentId,
        targetCloudAgentName: targetCloudAgentId
          ? targetAgentDisplayName
          : null,
        targetCloudAgentOwnerName: targetCloudAgentId
          ? targetHumanDisplayName
          : null,
      }];
    });
  });
}

export function isRecentCloudAgentMention(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs)
    && Date.now() - createdAtMs <= CLOUD_AGENT_MENTION_WINDOW_MS;
}

export function shouldRunLocalCloudAgentForCloudMessage({
  account,
  isGroupControl,
  peerId,
  message,
  peerMessages,
}: {
  account: CloudAccount;
  isGroupControl?: boolean;
  peerId: string;
  message: CloudMessage;
  peerMessages: readonly CloudMessage[];
}): boolean {
  if (peerId === account.accountId) return false;
  if (
    message.fromAccountId !== account.accountId
    && message.toAccountId !== account.accountId
  ) return false;
  if (
    (isGroupControl ?? Boolean(parseCloudGroupControl(message.body)))
    || parseCloudAgentResponse(message.body)
    || parseCloudAgentCancel(message.body)
  ) return false;
  if (
    !cloudMessageActionAllowsAgentTrigger(
      cloudDirectMessageAction(message.body),
    )
  ) return false;
  const targetsHostedCloudAgent =
    cloudDirectMessageTargetsOwnedHostedCloudAgent(
      message.body,
      account.accountId,
    );
  const directEnvelope = parseCloudDirectMessageEnvelope(message.body);
  const targetsLocalAgent =
    [defaultCloudAgentId(account.accountId), 'cloud-local-agent'].includes(
      directEnvelope?.targetCloudAgentId?.trim() ?? '',
    )
    && directEnvelope?.targetCloudAgentOwnerAccountId?.trim()
      === account.accountId;
  const hasExplicitAgentTarget = Boolean(
    directEnvelope?.targetCloudAgentId?.trim()
    || directEnvelope?.targetCloudAgentOwnerAccountId?.trim(),
  );
  if (hasExplicitAgentTarget && !targetsHostedCloudAgent && !targetsLocalAgent) {
    return false;
  }
  if (
    !targetsHostedCloudAgent
    && !targetsLocalAgent
    && !cloudMessageMentionsLocalAgent(
      cloudDirectMessageDisplayText(message.body),
      account,
      {
        allowFirstPerson: message.fromAccountId === account.accountId,
      },
    )
  ) return false;
  if (!isRecentCloudAgentMention(message.createdAt)) return false;
  return !cloudAgentResponseExistsForRequest({
    account,
    requestMessageId: message.messageId,
    peerMessages,
  });
}
