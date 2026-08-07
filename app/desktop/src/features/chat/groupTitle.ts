import type { ConversationParticipant } from '@/kordi-app/types';

export type GroupTitleSessionCandidate = {
  sessionId: string;
  groupSpaceId?: string | null;
  customName?: string | null;
  groupNameUpdatedAtMs?: number | null;
};

export type ReplicatedGroupTitleResolution = {
  title: string;
  updatedAtMs: number;
  appliesIncoming: boolean;
};

function cleanText(value?: string | null) {
  return value?.trim() ?? '';
}

export function normalizeGroupTitleSpaceId(value?: string | null) {
  const text = cleanText(value);
  return text.startsWith('group:') ? text.slice('group:'.length) : text;
}

function nonGenericGroupName(value?: string | null) {
  const title = cleanText(value);
  if (!title) return '';
  if (title.startsWith('session:') || title.startsWith('bridge:') || title.startsWith('canonical:')) return '';
  return /^(?:#\s*)?(?:group|session|new (?:session|chat)|untitled session)$/iu.test(title) ? '' : title;
}

function validUpdatedAtMs(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function groupMetadataWithoutSessionTitleOwnership(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const groupMetadata = { ...metadata };
  delete groupMetadata.titleSource;
  delete groupMetadata.sessionTitleSource;
  return groupMetadata;
}

/**
 * Resolve the one shared group label independently of session activity order.
 * A replicated rename wins first; otherwise the canonical group root owns the
 * initial name. The stable final tie-break prevents two viewers with a
 * different local session order from selecting different child labels.
 */
export function sharedGroupCustomTitle(
  candidates: GroupTitleSessionCandidate[],
  fallbackGroupSpaceId?: string | null,
) {
  const fallbackId = normalizeGroupTitleSpaceId(fallbackGroupSpaceId);
  const normalized = candidates.map((candidate) => {
    const sessionId = normalizeGroupTitleSpaceId(candidate.sessionId);
    const groupSpaceId = normalizeGroupTitleSpaceId(candidate.groupSpaceId) || fallbackId;
    return {
      title: nonGenericGroupName(candidate.customName),
      sessionId,
      isRoot: Boolean(sessionId && groupSpaceId && sessionId === groupSpaceId),
      updatedAtMs: validUpdatedAtMs(candidate.groupNameUpdatedAtMs),
    };
  });
  const hasCanonicalRoot = normalized.some((candidate) => candidate.isRoot);
  return normalized
    .filter((candidate) => (
      candidate.title
      && (!hasCanonicalRoot || candidate.isRoot || candidate.updatedAtMs > 0)
    ))
    .sort((left, right) => {
      const leftWasRenamed = left.updatedAtMs > 0;
      const rightWasRenamed = right.updatedAtMs > 0;
      if (leftWasRenamed !== rightWasRenamed) return leftWasRenamed ? -1 : 1;
      if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
      if (left.isRoot !== right.isRoot) return left.isRoot ? -1 : 1;
      return left.sessionId.localeCompare(right.sessionId) || left.title.localeCompare(right.title);
    })[0]?.title ?? '';
}

export function resolveReplicatedGroupTitle(input: {
  candidates: GroupTitleSessionCandidate[];
  groupSpaceId?: string | null;
  incomingTitle?: string | null;
  incomingUpdatedAtMs?: number | null;
  replaceStoredTitle?: boolean;
}): ReplicatedGroupTitleResolution {
  const storedTitle = sharedGroupCustomTitle(input.candidates, input.groupSpaceId);
  const storedUpdatedAtMs = input.candidates.reduce((latest, candidate) => (
    nonGenericGroupName(candidate.customName)
      ? Math.max(latest, validUpdatedAtMs(candidate.groupNameUpdatedAtMs))
      : latest
  ), 0);
  const incomingTitle = nonGenericGroupName(input.incomingTitle);
  const incomingUpdatedAtMs = validUpdatedAtMs(input.incomingUpdatedAtMs);
  const appliesIncoming = Boolean(
    incomingTitle
    && (!storedTitle || (input.replaceStoredTitle !== false && incomingUpdatedAtMs >= storedUpdatedAtMs)),
  );
  return {
    title: appliesIncoming ? incomingTitle : storedTitle,
    updatedAtMs: appliesIncoming ? incomingUpdatedAtMs : storedUpdatedAtMs,
    appliesIncoming,
  };
}

export function groupParticipantStableKey(participant: Pick<
  ConversationParticipant,
  'id' | 'name' | 'humanId' | 'sourceIdentityId'
>) {
  return cleanText(participant.humanId)
    || cleanText(participant.sourceIdentityId)
    || cleanText(participant.id)
    || cleanText(participant.name).toLocaleLowerCase();
}

function compareGroupParticipantStableKeys(
  left: Pick<ConversationParticipant, 'id' | 'name' | 'humanId' | 'sourceIdentityId'>,
  right: Pick<ConversationParticipant, 'id' | 'name' | 'humanId' | 'sourceIdentityId'>,
) {
  return groupParticipantStableKey(left).localeCompare(
    groupParticipantStableKey(right),
    'en',
    { numeric: true, sensitivity: 'base' },
  );
}

/**
 * Legacy groups without a shared custom name still need the same fallback on
 * every device. Exclude the canonical creator (not the current viewer). For
 * records that predate creator metadata, use the same stable identity anchor
 * on every device instead of whichever participant happens to be local.
 */
export function deterministicGroupParticipantTitle(
  participants: ConversationParticipant[],
  creatorIdentityId?: string | null,
) {
  const creatorId = cleanText(creatorIdentityId);
  const humans = participants
    .filter((participant) => participant.kind === 'human')
    .sort(compareGroupParticipantStableKeys);
  const legacySelfPlaceholderId = humans.find((participant) => cleanText(participant.id) === 'human:me')?.id ?? '';
  const stableAnchorId = creatorId || legacySelfPlaceholderId || cleanText(humans[0]?.id);
  const withoutAnchor = stableAnchorId
    ? humans.filter((participant) => cleanText(participant.id) !== stableAnchorId)
    : humans;
  const candidates = withoutAnchor.length > 0 ? withoutAnchor : humans;
  const seen = new Set<string>();
  const names = [...candidates]
    .sort((left, right) => (
      compareGroupParticipantStableKeys(left, right)
      || cleanText(left.publicName || left.name).localeCompare(
        cleanText(right.publicName || right.name),
        'en',
        { numeric: true, sensitivity: 'base' },
      )
    ))
    .flatMap((participant) => {
      const name = cleanText(participant.publicName || participant.name);
      const key = groupParticipantStableKey(participant) || name.toLocaleLowerCase();
      if (!name || !key || seen.has(key)) return [];
      seen.add(key);
      return [name];
    });

  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}
