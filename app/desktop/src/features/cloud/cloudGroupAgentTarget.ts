import type { MessageMention } from '@/kordi-app/types';
import type { CloudGroupControlEnvelope, CloudGroupParticipant } from './cloudGroupMessages';

export type CloudGroupAgentTarget = { ownerAccountId: string; agentId: string };
type GroupMessage = NonNullable<CloudGroupControlEnvelope['message']>;
const clean = (value?: string | null) => value?.trim() ?? '';
const normalized = (value: string) => value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function targetForIds(agent: string, owner: string, sender: string, participants: readonly CloudGroupParticipant[]): CloudGroupAgentTarget | null {
  if (!owner || !participants.some((p) => p.accountId === owner)) return null;
  const agentId = agent === `cloud-self:${owner}` || (agent === 'cloud-local-agent' && owner === sender)
    ? `cloud-agent:${owner}` : agent;
  return agentId === `cloud-agent:${owner}` || agentId.startsWith('cloud_agent_')
    ? { ownerAccountId: owner, agentId } : null;
}

function mentionTarget(mention: MessageMention, message: GroupMessage, participants: readonly CloudGroupParticipant[]): CloudGroupAgentTarget | null {
  if (clean(mention.sourceHostId) && mention.sourceHostId !== 'cloud') return null;
  const identity = clean(mention.targetIdentityId);
  const identityAgent = identity.startsWith('agent:cloud-agent:cloud-agent:') || identity.startsWith('agent:cloud-agent:cloud_agent_')
    ? identity.slice('agent:cloud-agent:'.length)
    : identity.startsWith('agent:') ? identity.slice('agent:'.length) : '';
  const agent = clean(mention.agentId) || identityAgent;
  const inferredOwner = agent.startsWith('cloud-agent:') ? agent.slice('cloud-agent:'.length)
    : participants.find((p) => p.agentId === agent || p.accountId === agent || `cloud:${p.accountId}` === agent)?.accountId ?? '';
  const owner = clean(mention.humanId) || clean(mention.nodeId) || inferredOwner;
  const canonical = (id: string) => owner && (id === owner || id === `cloud:${owner}`)
    ? `cloud-agent:${owner}` : id;
  const canonicalAgent = canonical(agent);
  if (identity && (!identityAgent || canonical(identityAgent) !== canonicalAgent)) return null;
  const start = mention.startUtf16;
  const length = mention.lengthUtf16;
  if (start != null || length != null) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start! < 0 || length! < 1
      || !mention.displayText?.startsWith('@') || mention.displayText.length !== length
      || message.text.slice(start!, start! + length) !== mention.displayText) return null;
  } else if (!mention.label || !tokens(message.text).some((token) => normalized(token) === normalized(mention.label))) {
    return null;
  }
  return targetForIds(canonicalAgent, owner, message.senderAccountId, participants);
}

function tokens(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)@(my[ \t]+kordi(?=$|[\s:;,.!?—-])|[\p{L}\p{N}._'’-]+)/giu)].map((match) => match[1]);
}

/** Human group requests have one target. Display names never grant each recipient its own request. */
export function cloudGroupHumanAgentTarget(message: GroupMessage, participants: readonly CloudGroupParticipant[]): CloudGroupAgentTarget | null {
  if (message.senderKind === 'agent' || message.forkSnapshot || message.messageAction?.kind === 'forward') return null;
  const sender = clean(message.senderAccountId);
  if (!participants.some((p) => p.accountId === sender)) return null;
  const agent = clean(message.targetCloudAgentId);
  const owner = clean(message.targetCloudAgentOwnerAccountId);
  const explicit = agent || owner ? targetForIds(agent, owner, sender, participants) : null;
  if ((agent || owner) && !explicit) return null;
  const mentions = message.mentions ?? [];
  const agentMentions = mentions.filter((m) => m.targetKind === 'agent');
  if (agentMentions.length) {
    const targets = agentMentions.map((m) => mentionTarget(m, message, participants));
    if (targets.some((t) => !t)) return null;
    const unique = [...new Map(targets.map((t) => [t!.agentId, t!])).values()];
    if (unique.length !== 1) return null;
    return !explicit || (explicit.agentId === unique[0].agentId && explicit.ownerAccountId === unique[0].ownerAccountId) ? unique[0] : null;
  }
  if (explicit) return explicit;
  let legacyText = message.text;
  for (const mention of mentions) {
    const start = mention.startUtf16;
    const length = mention.lengthUtf16;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start! < 0 || length! < 1
      || start! > message.text.length || length! > message.text.length - start!
      || !mention.displayText?.startsWith('@') || mention.displayText.length !== length
      || message.text.slice(start!, start! + length) !== mention.displayText) return null;
    legacyText = legacyText.slice(0, start!) + ' '.repeat(length) + legacyText.slice(start! + length);
  }

  const candidates = new Map<string, CloudGroupAgentTarget>();
  for (const token of tokens(legacyText)) {
    const handle = normalized(token);
    if (handle === 'kordi' || handle === 'mykordi') {
      candidates.set(`cloud-agent:${sender}`, { ownerAccountId: sender, agentId: `cloud-agent:${sender}` });
      continue;
    }
    const matches = participants.filter((p) => {
      const person = normalized(p.displayName);
      const name = normalized(p.agentDisplayName || 'Kordi');
      return [name + person, 'kordi' + person, person + 'kordi', person + 'skordi'].includes(handle);
    });
    if (matches.length > 1) return null;
    const participant = matches[0];
    if (participant) {
      const target = targetForIds(participant.agentId || `cloud-agent:${participant.accountId}`, participant.accountId, sender, participants);
      if (!target) return null;
      candidates.set(target.agentId, target);
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

export function cloudGroupMessageWithAgentTarget(message: GroupMessage, participants: readonly CloudGroupParticipant[]): GroupMessage {
  const target = cloudGroupHumanAgentTarget(message, participants);
  return target ? { ...message, targetCloudAgentId: target.agentId, targetCloudAgentOwnerAccountId: target.ownerAccountId } : message;
}
