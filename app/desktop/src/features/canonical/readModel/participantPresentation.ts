import type { ConversationParticipant } from '@/kordi-app/types';

const CLOUD_SELF_AGENT_PREFIX = 'agent:cloud-self:';
const LOCAL_AGENT_PREFIX = 'agent:local:';

function normalized(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

function ownerKey(participant: ConversationParticipant) {
  const ownerIdentityId = participant.ownerIdentityId?.trim();
  if (ownerIdentityId) return `id:${ownerIdentityId}`;
  const ownerName = normalized(participant.ownerName);
  return ownerName ? `name:${ownerName}` : '';
}

function isSelfAgentIdentity(participant: ConversationParticipant) {
  return participant.id.startsWith(CLOUD_SELF_AGENT_PREFIX) || participant.id.startsWith(LOCAL_AGENT_PREFIX);
}

function isOnline(participant: ConversationParticipant) {
  return normalized(participant.presenceStatus) === 'online';
}

function sameOwnedAgent(left: ConversationParticipant, right: ConversationParticipant) {
  if (left.kind !== 'agent' || right.kind !== 'agent') return false;
  const owner = ownerKey(left);
  if (!owner || owner !== ownerKey(right)) return false;
  return normalized(left.name) === normalized(right.name)
    || (isSelfAgentIdentity(left) && isSelfAgentIdentity(right));
}

function mergeOwnedAgent(kept: ConversationParticipant, duplicate: ConversationParticipant) {
  const survivor = duplicate.id.startsWith(CLOUD_SELF_AGENT_PREFIX) && !kept.id.startsWith(CLOUD_SELF_AGENT_PREFIX)
    ? duplicate
    : kept;
  const other = survivor === kept ? duplicate : kept;
  if (isOnline(survivor) || !isOnline(other)) return survivor;
  return { ...survivor, presenceStatus: other.presenceStatus, presenceDetail: other.presenceDetail };
}

/**
 * Display-only participant list. An owner's agent can appear under two
 * identities (the cloud self agent `agent:cloud-self:…` and the Mac-local
 * delegate `agent:local:…`). Agents with the same owner and either the same
 * name or both being self-agent identities collapse into one row; the cloud
 * self identity survives and keeps presence from whichever copy is online.
 * Routing keeps the full canonical list, so only display surfaces use this.
 */
export function displayCanonicalParticipants(participants: readonly ConversationParticipant[]) {
  const result: ConversationParticipant[] = [];
  for (const participant of participants) {
    const index = result.findIndex((candidate) => sameOwnedAgent(candidate, participant));
    if (index === -1) result.push(participant);
    else result[index] = mergeOwnedAgent(result[index], participant);
  }
  return result;
}
