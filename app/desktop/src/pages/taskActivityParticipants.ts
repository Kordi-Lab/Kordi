import { type TaskDashboardItem,type TaskDashboardSubtask } from '@/features/chat/taskActivityDashboard';
import type { ConversationParticipant,SessionTaskActivity } from '@/kordi-app/types';

export type TaskTargetParticipant = Pick<ConversationParticipant,
  | 'id'
  | 'name'
  | 'kind'
  | 'role'
  | 'ownerName'
  | 'agentId'
  | 'avatarKey'
  | 'profileImageUrl'
> & {
  avatarSeed?: string | null;
};

export type TaskDashboardSubtaskWithOutput = TaskDashboardSubtask & {
  responseMessageId?: string | null;
  outputPreview?: boolean;
};

export type TaskDashboardItemWithParticipants = Omit<TaskDashboardItem, 'subtasks'> & {
  targetParticipants?: TaskTargetParticipant[];
  subtasks: TaskDashboardSubtaskWithOutput[];
  subtaskCountLabel?: string | null;
};

export function normalizedParticipantMatchText(value?: string | null) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function userNumberLabel(value: string) {
  return /\buser\s*(\d+)\b/i.exec(value)?.[1] ?? null;
}

export function taskSearchText(task: TaskDashboardItem) {
  return [
    task.title,
    task.summary,
    task.target,
    ...task.subtasks.flatMap((subtask) => [subtask.title, subtask.summary, subtask.target]),
  ].filter((value): value is string => Boolean(value?.trim())).join(' ');
}

export function participantAliasValues(participant: Pick<TaskTargetParticipant, 'id' | 'name' | 'ownerName' | 'avatarKey'>) {
  const values = [participant.name, participant.ownerName, participant.id, participant.avatarKey]
    .filter((value): value is string => Boolean(value?.trim()));
  return Array.from(new Set(values.flatMap((value) => {
    const trimmed = value.trim();
    const withoutPrefix = trimmed.includes(':') ? trimmed.split(':').filter(Boolean).pop() ?? trimmed : trimmed;
    return [trimmed, withoutPrefix];
  }).filter(Boolean)));
}

export function participantMatchesTask(participant: TaskTargetParticipant, taskText: string, normalizedTaskText: string) {
  for (const alias of participantAliasValues(participant)) {
    const normalizedAlias = normalizedParticipantMatchText(alias);
    if (normalizedAlias && (normalizedTaskText.includes(normalizedAlias) || normalizedAlias.includes(normalizedTaskText))) return true;
    const participantUserNumber = userNumberLabel(alias);
    if (participantUserNumber && participantUserNumber === userNumberLabel(taskText)) return true;
  }
  return false;
}

export function fallbackParticipantForInvolvedName(name: string): TaskTargetParticipant {
  return {
    id: `task-involved:${name}`,
    name,
    kind: 'human',
    role: 'participant',
    avatarKey: name,
  };
}

export function taskTargetParticipants(task: TaskDashboardItem, participants: TaskTargetParticipant[]) {
  if (task.involvedParticipantNames.length === 0) return [];
  const involvedText = task.involvedParticipantNames.join(' ');
  const normalizedInvolvedText = normalizedParticipantMatchText(involvedText);
  const humans = participants.filter((participant) => participant.kind !== 'agent' && participantMatchesTask(participant, involvedText, normalizedInvolvedText));
  const matched = (humans.length > 0 ? humans : participants.filter((participant) => participantMatchesTask(participant, involvedText, normalizedInvolvedText))).slice(0, 4);
  const matchedText = normalizedParticipantMatchText(matched.flatMap(participantAliasValues).join(' '));
  const fallbackParticipants = task.involvedParticipantNames
    .filter((name) => {
      const normalizedName = normalizedParticipantMatchText(name);
      return normalizedName && !matchedText.includes(normalizedName);
    })
    .map(fallbackParticipantForInvolvedName);
  return [...matched, ...fallbackParticipants].slice(0, 4);
}

export function matchingCanonicalParticipant(participant: SessionTaskActivity['participants'][number] | SessionTaskActivity['initiator'] | null | undefined, targetParticipants: TaskTargetParticipant[]) {
  if (!participant) return undefined;
  const participantAliases = new Set(participantAliasValues(participant).map(normalizedParticipantMatchText).filter(Boolean));
  return targetParticipants.find((targetParticipant) => (
    participantAliasValues(targetParticipant)
      .map(normalizedParticipantMatchText)
      .filter(Boolean)
      .some((alias) => participantAliases.has(alias))
  ));
}

export function enrichTaskParticipant(participant: SessionTaskActivity['participants'][number], targetParticipants: TaskTargetParticipant[]): SessionTaskActivity['participants'][number] {
  const canonical = matchingCanonicalParticipant(participant, targetParticipants);
  return canonical ? {
    ...participant,
    name: canonical.name || participant.name,
    avatarKey: canonical.avatarKey ?? participant.avatarKey,
    profileImageUrl: canonical.profileImageUrl ?? participant.profileImageUrl,
    role: canonical.role ?? participant.role,
  } : participant;
}

export function participantDedupeKey(participant: TaskTargetParticipant) {
  const accountAlias = participantAliasValues(participant).find((alias) => /^acct_[a-z0-9]+$/i.test(alias));
  if (accountAlias) return `account:${accountAlias.toLowerCase()}`;
  return `name:${normalizedParticipantMatchText(participant.name) || participant.id}`;
}

export function participantNameLooksTechnical(name?: string | null) {
  const value = name?.trim() ?? '';
  return !value || /^acct_[a-z0-9]+$/i.test(value) || /^cloud:acct_[a-z0-9]+$/i.test(value);
}

export function mergeTaskTargetParticipants(participants: TaskTargetParticipant[]) {
  const byKey = new Map<string, TaskTargetParticipant>();
  for (const participant of participants) {
    const key = participantDedupeKey(participant);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, participant);
      continue;
    }
    const participantHasBetterName = participantNameLooksTechnical(existing.name) && !participantNameLooksTechnical(participant.name);
    byKey.set(key, {
      ...existing,
      ...participant,
      name: participantHasBetterName ? participant.name : existing.name,
      ownerName: participant.ownerName ?? existing.ownerName,
      avatarKey: participant.avatarKey ?? existing.avatarKey,
      avatarSeed: participant.avatarSeed ?? existing.avatarSeed,
      profileImageUrl: participant.profileImageUrl ?? existing.profileImageUrl,
      role: participant.role ?? existing.role,
    });
  }
  return [...byKey.values()];
}
