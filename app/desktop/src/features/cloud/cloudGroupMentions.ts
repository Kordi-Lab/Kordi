import {
  publicPersonMentionHandle,
  publicScopedAgentMentionHandle,
} from '@/lib/identityLabels';
import type {
  CloudGroupControlEnvelope,
  CloudGroupParticipant,
} from './cloudGroupMessages';

export const CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH = 1;

export type CloudGroupMentionCatalogEntry = {
  accountId: string;
  displayName: string;
  handle: string;
  targetKind: 'person' | 'agent';
};

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
        displayName,
        handle: publicPersonMentionHandle(displayName),
        targetKind: 'person',
      }, {
        accountId,
        displayName,
        handle: publicScopedAgentMentionHandle(displayName, 'Kordi'),
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
  requesterAccountId,
  requesterKind,
  allowAgentMentions,
}: {
  participants: readonly CloudGroupParticipant[];
  respondingAccountId: string;
  requesterAccountId?: string | null;
  requesterKind?: 'human' | 'agent' | null;
  allowAgentMentions: boolean;
}): string | null {
  const catalog = cloudGroupMentionCatalog(participants);
  const people = catalog
    .filter((entry) => entry.targetKind === 'person')
    .map((entry) => `@${entry.handle} (${entry.displayName})`);
  const agents = allowAgentMentions
    ? catalog
      .filter((entry) => (
        entry.targetKind === 'agent'
        && entry.accountId !== respondingAccountId.trim()
      ))
      .map((entry) => `@${entry.handle} (${entry.displayName}'s Kordi)`)
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
    ? `Current requester: @${requesterAgent.handle} (${requesterAgent.displayName}'s Kordi).`
    : requesterPerson
      ? `Current requester: @${requesterPerson.handle} (${requesterPerson.displayName}).`
        + (requesterAgent
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

export function resolveCloudGroupAgentMention({
  text,
  participants,
  respondingAccountId,
}: {
  text: string;
  participants: readonly CloudGroupParticipant[];
  respondingAccountId: string;
}): CloudGroupMentionCatalogEntry | null {
  const agentsByHandle = new Map(
    cloudGroupMentionCatalog(participants)
      .filter((entry) => (
        entry.targetKind === 'agent'
        && entry.accountId !== respondingAccountId.trim()
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
  requestMessage,
}: {
  responseText: string;
  participants: readonly CloudGroupParticipant[];
  respondingAccountId: string;
  requestMessage: CloudGroupControlEnvelope['message'];
}): Pick<
  NonNullable<CloudGroupControlEnvelope['message']>,
  | 'targetCloudAgentOwnerAccountId'
  | 'targetCloudAgentOwnerName'
  | 'agentMentionDepth'
> | null {
  const requestDepth = cloudGroupAgentMentionDepth(requestMessage);
  if (requestDepth >= CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH) return null;
  const target = resolveCloudGroupAgentMention({
    text: responseText,
    participants,
    respondingAccountId,
  });
  return target ? {
    targetCloudAgentOwnerAccountId: target.accountId,
    targetCloudAgentOwnerName: target.displayName,
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
    || message.targetCloudAgentId?.trim()
  ) return null;
  const targetOwnerAccountId = message.targetCloudAgentOwnerAccountId?.trim();
  if (!targetOwnerAccountId) return null;
  const target = resolveCloudGroupAgentMention({
    text: message.text,
    participants: envelope.participants,
    respondingAccountId: message.senderAccountId,
  });
  return target?.accountId === targetOwnerAccountId ? target : null;
}

export function cloudGroupAgentHandoffTargetsAccount(
  envelope: Pick<CloudGroupControlEnvelope, 'participants' | 'message'>,
  accountId: string,
): boolean {
  return cloudGroupAgentHandoffTarget(envelope)?.accountId
    === accountId.trim();
}
