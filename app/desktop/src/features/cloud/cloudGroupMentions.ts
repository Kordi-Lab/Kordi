import {
  publicPersonMentionHandle,
  publicScopedAgentMentionHandle,
} from '@/lib/identityLabels';
import { cloudAgentId, defaultCloudAgentId } from './cloudAgentIdentity';
import type {
  CloudGroupControlEnvelope,
  CloudGroupParticipant,
} from './cloudGroupMessages';

export const CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH = 1;

export type CloudGroupMentionCatalogEntry = {
  accountId: string;
  agentId: string | null;
  displayName: string;
  ownerDisplayName: string;
  handle: string;
  targetKind: 'person' | 'agent';
};

export type CloudGroupAgentHandoff = Pick<
  NonNullable<CloudGroupControlEnvelope['message']>,
  | 'targetCloudAgentId'
  | 'targetCloudAgentOwnerAccountId'
  | 'targetCloudAgentOwnerName'
  | 'agentMentionDepth'
>;

const CLOUD_GROUP_MENTION_PATTERN = /@[\p{L}\p{N}._'’-]+/gu;

function cleanDisplayName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function normalizedMentionHandle(value: string): string {
  return value
    .normalize('NFKC')
    .match(/[\p{L}\p{N}]+/gu)
    ?.join('')
    .toLocaleLowerCase('en-US') ?? '';
}

export function cloudGroupMentionCatalog(
  participants: readonly CloudGroupParticipant[],
): CloudGroupMentionCatalogEntry[] {
  const participantsByAccount = new Map<string, CloudGroupParticipant>();
  for (const participant of participants) {
    const accountId = participant.accountId.trim();
    if (accountId && !participantsByAccount.has(accountId)) {
      participantsByAccount.set(accountId, participant);
    }
  }
  const candidates = [...participantsByAccount.values()].flatMap(
    (participant): CloudGroupMentionCatalogEntry[] => {
      const accountId = participant.accountId.trim();
      const displayName = cleanDisplayName(participant.displayName);
      if (!accountId || !displayName) return [];
      return [{
        accountId,
        agentId: null,
        displayName,
        ownerDisplayName: displayName,
        handle: publicPersonMentionHandle(displayName),
        targetKind: 'person',
      }, {
        accountId,
        agentId: participant.agentId?.trim() || defaultCloudAgentId(accountId),
        displayName: participant.agentDisplayName?.trim() || 'Kordi',
        ownerDisplayName: displayName,
        handle: publicScopedAgentMentionHandle(
          displayName,
          participant.agentDisplayName?.trim() || 'Kordi',
        ),
        targetKind: 'agent',
      }];
    },
  );
  const handleCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = normalizedMentionHandle(candidate.handle);
    if (key) handleCounts.set(key, (handleCounts.get(key) ?? 0) + 1);
  }
  return candidates.filter((candidate) => (
    handleCounts.get(normalizedMentionHandle(candidate.handle)) === 1
  ));
}

export function cloudGroupAgentMentionDepth(
  message: CloudGroupControlEnvelope['message'],
): number {
  const depth = message?.agentMentionDepth;
  return typeof depth === 'number'
    && Number.isInteger(depth)
    && depth >= 0
    ? depth
    : 0;
}

export function cloudGroupMentionInstruction({
  participants,
  respondingAccountId,
  respondingAgentId,
  requesterAccountId,
  requesterKind,
  allowAgentMentions,
}: {
  participants: readonly CloudGroupParticipant[];
  respondingAccountId: string;
  respondingAgentId?: string | null;
  requesterAccountId?: string | null;
  requesterKind?: 'human' | 'agent' | null;
  allowAgentMentions: boolean;
}): string | null {
  const currentAgentId = cloudAgentId(
    respondingAgentId,
    respondingAccountId,
  );
  const catalog = cloudGroupMentionCatalog(participants);
  const people = catalog
    .filter((entry) => entry.targetKind === 'person')
    .map((entry) => `@${entry.handle} (${entry.displayName})`);
  const agents = allowAgentMentions
    ? catalog
      .filter((entry) => (
        entry.targetKind === 'agent'
        && entry.agentId !== currentAgentId
      ))
      .map((entry) => `@${entry.handle} (${entry.displayName}; owner: ${entry.ownerDisplayName})`)
    : [];
  const requesterPerson = catalog.find((entry) => (
    entry.targetKind === 'person'
    && entry.accountId === requesterAccountId?.trim()
  ));
  const requesterAgent = catalog.find((entry) => (
    entry.targetKind === 'agent'
    && entry.accountId === requesterAccountId?.trim()
  ));
  const requesterDescription = requesterKind === 'agent' && requesterAgent
    ? `Current requester: @${requesterAgent.handle} (${requesterAgent.displayName}; owner: ${requesterAgent.ownerDisplayName}).`
    : requesterPerson
      ? `Current requester: @${requesterPerson.handle} (${requesterPerson.displayName}).`
        + (requesterAgent && requesterAgent.agentId !== currentAgentId
          ? ` In this request, "my Kordi" means @${requesterAgent.handle}.`
          : '')
      : null;
  if (people.length === 0 && agents.length === 0) return null;
  return [
    'Group @mention permissions: use only the exact handles listed below; never invent a handle.',
    ...(requesterDescription ? [requesterDescription] : []),
    ...(people.length > 0 ? [`People: ${people.join(', ')}`] : []),
    ...(agents.length > 0 ? [
      `Agents: ${agents.join(', ')}`,
      'To ask another participant\'s Kordi to act, include exactly one permitted agent handle followed by the request in your final response.',
    ] : !allowAgentMentions ? [
      'This request already came from another agent. You may mention people, but do not ask another agent.',
    ] : [
      'No other unambiguous participant Kordi handle is available in this group.',
    ]),
  ].join('\n');
}

export function cloudGroupAgentPersonaInstruction({
  respondingAgentDisplayName,
  respondingAgentId,
  respondingAccountId,
  requesterAccountId,
  requesterKind,
  allowAgentMentions,
}: {
  respondingAgentDisplayName?: string | null;
  respondingAgentId?: string | null;
  respondingAccountId: string;
  requesterAccountId?: string | null;
  requesterKind?: 'human' | 'agent' | null;
  allowAgentMentions: boolean;
}): string {
  const currentAgentId = cloudAgentId(
    respondingAgentId,
    respondingAccountId,
  );
  const requesterAgentId = defaultCloudAgentId(
    requesterAccountId?.trim() ?? '',
  );
  const relationship = requesterKind === 'agent'
    ? 'This request came from another agent. Do not delegate to another agent.'
    : requesterAgentId && requesterAgentId === currentAgentId
      ? 'The human requester owns you. In this request, "my Kordi" means you. Perform the request directly and never mention or delegate to your own public handle.'
      : 'The current human requester does not own you. In this request, "my Kordi" means the requester\'s default Kordi, not you.';
  return [
    `You are ${respondingAgentDisplayName?.trim() || 'Kordi'}, the currently responding agent in this Kordi group conversation.`,
    relationship,
    allowAgentMentions
      ? 'You may delegate once only to a different agent through an exact handle supplied in the group mention directory.'
      : 'Do not delegate to another agent in this response.',
  ].join('\n');
}

export function resolveCloudGroupAgentMention({
  text,
  participants,
  respondingAccountId,
  respondingAgentId,
}: {
  text: string;
  participants: readonly CloudGroupParticipant[];
  respondingAccountId: string;
  respondingAgentId?: string | null;
}): CloudGroupMentionCatalogEntry | null {
  const currentAgentId = cloudAgentId(
    respondingAgentId,
    respondingAccountId,
  );
  const agentsByHandle = new Map(
    cloudGroupMentionCatalog(participants)
      .filter((entry) => (
        entry.targetKind === 'agent'
        && entry.agentId !== currentAgentId
      ))
      .map((entry) => [normalizedMentionHandle(entry.handle), entry]),
  );
  for (const mention of text.match(CLOUD_GROUP_MENTION_PATTERN) ?? []) {
    const target = agentsByHandle.get(
      normalizedMentionHandle(mention.slice(1)),
    );
    if (target) return target;
  }
  return null;
}

export function cloudGroupAgentHandoffForResponse({
  responseText,
  participants,
  respondingAccountId,
  respondingAgentId,
  requestMessage,
}: {
  responseText: string;
  participants: readonly CloudGroupParticipant[];
  respondingAccountId: string;
  respondingAgentId?: string | null;
  requestMessage: CloudGroupControlEnvelope['message'];
}): CloudGroupAgentHandoff | null {
  const requestDepth = cloudGroupAgentMentionDepth(requestMessage);
  if (requestDepth >= CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH) return null;
  const target = resolveCloudGroupAgentMention({
    text: responseText,
    participants,
    respondingAccountId,
    respondingAgentId,
  });
  return target ? {
    targetCloudAgentId: target.agentId,
    targetCloudAgentOwnerAccountId: target.accountId,
    targetCloudAgentOwnerName: target.ownerDisplayName,
    agentMentionDepth: requestDepth + 1,
  } : null;
}

export function cloudGroupAgentHandoffTarget(
  envelope: Pick<CloudGroupControlEnvelope, 'participants' | 'message'>,
): CloudGroupMentionCatalogEntry | null {
  const message = envelope.message;
  if (
    !message
    || message.senderKind !== 'agent'
    || cloudGroupAgentMentionDepth(message)
      !== CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH
  ) return null;
  const targetOwnerAccountId = message.targetCloudAgentOwnerAccountId?.trim();
  if (!targetOwnerAccountId) return null;
  const target = resolveCloudGroupAgentMention({
    text: message.text,
    participants: envelope.participants,
    respondingAccountId: message.senderAccountId,
    respondingAgentId: message.senderAgentId,
  });
  const targetAgentId = message.targetCloudAgentId?.trim();
  return target?.accountId === targetOwnerAccountId
    && (!targetAgentId || target.agentId === targetAgentId)
    ? target
    : null;
}

export function cloudGroupAgentHandoffTargetsAccount(
  envelope: Pick<CloudGroupControlEnvelope, 'participants' | 'message'>,
  accountId: string,
): boolean {
  return cloudGroupAgentHandoffTarget(envelope)?.accountId
    === accountId.trim();
}
