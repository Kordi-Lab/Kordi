import {
  compatibleSourceHostId,
  normalizeCollaborationTargetKind,
} from '@/features/collaboration/legacyBridgeCompatibility';
import type { MessageMention } from '@/kordi-app/types';
import {
  conversationHasGroupMentionScope,
  mentionHandleForLabel,
  type MentionScopeConversation,
} from './messageActions/mentions';
import type { ResolvedMentionedCollaborationTarget } from './messageActions/types';

const MAX_MENTIONS = 32;
const MAX_MENTION_TEXT_LENGTH = 256;
const MAX_MENTION_ID_LENGTH = 256;
export const ALL_GROUP_MENTION_LABEL = 'all';

export function groupMentionTargetIdentityId(sessionId: string | null | undefined) {
  const value = sessionId?.trim();
  if (!value) return null;
  return value.startsWith('group:') ? value : `group:${value}`;
}

export function isVerifiedAllGroupMention(mention: Pick<
  MessageMention,
  'label' | 'targetKind' | 'targetIdentityId' | 'startUtf16' | 'lengthUtf16' | 'displayText'
>) {
  const targetIdentityId = mention.targetIdentityId?.trim() ?? '';
  return mention.targetKind === 'all'
    && mention.label.trim().toLocaleLowerCase() === ALL_GROUP_MENTION_LABEL
    && Number.isSafeInteger(mention.startUtf16)
    && (mention.startUtf16 ?? -1) >= 0
    && mention.lengthUtf16 === 4
    && mention.displayText?.toLocaleLowerCase() === '@all'
    && groupMentionTargetIdentityId(targetIdentityId) === targetIdentityId
    && Boolean(targetIdentityId.slice('group:'.length).trim());
}

function mentionIdentityId(target: ResolvedMentionedCollaborationTarget) {
  const rawId = target.targetKind === 'agent'
    ? target.peer.agentId || target.peer.nodeId
    : target.peer.humanId || target.peer.nodeId;
  const prefix = target.targetKind === 'agent' ? 'agent:' : 'human:';
  return rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`;
}

function mentionDisplayRanges(text: string, target: ResolvedMentionedCollaborationTarget) {
  const ranges: Array<{ startUtf16: number; lengthUtf16: number; displayText: string }> = [];
  const aliases = [`@${target.displayLabel}`, `@${target.label}`]
    .filter((value, index, values) => value.length > 1 && values.indexOf(value) === index);
  for (const alias of aliases) {
    let startUtf16 = text.indexOf(alias);
    while (startUtf16 >= 0 && ranges.length < MAX_MENTIONS) {
      if (!ranges.some((range) => range.startUtf16 === startUtf16)) {
        ranges.push({ startUtf16, lengthUtf16: alias.length, displayText: alias });
      }
      startUtf16 = text.indexOf(alias, startUtf16 + alias.length);
    }
  }
  return ranges.sort((left, right) => left.startUtf16 - right.startUtf16);
}

export function mentionForCollaborationTarget(
  target: ResolvedMentionedCollaborationTarget | null,
  text?: string,
): MessageMention[] {
  if (!target) return [];
  const mention: MessageMention = {
    label: target.label,
    targetKind: target.targetKind,
    targetIdentityId: mentionIdentityId(target),
    sourceHostId: target.host.id,
    nodeId: target.peer.nodeId,
    humanId: target.peer.humanId ?? null,
    agentId: target.peer.agentId ?? null,
    displayLabel: target.displayLabel,
  };
  const ranges = text ? mentionDisplayRanges(text, target) : [];
  return ranges.length > 0 ? ranges.map((range) => ({ ...mention, ...range })) : [mention];
}

function isSelfConversationParticipant(participant: { kind?: string | null; role?: string | null; source?: string | null }) {
  return participant.role === 'self'
    || (participant.source === 'local' && participant.kind === 'human');
}

export function mentionsForConversationParticipants(
  text: string,
  conversation: MentionScopeConversation | null | undefined,
): MessageMention[] {
  const mentions: MessageMention[] = [];
  for (const participant of conversation?.canonicalParticipants ?? []) {
    if (participant.kind !== 'human' || isSelfConversationParticipant(participant)) continue;
    const displayLabel = participant.name?.trim();
    const humanId = participant.humanId?.trim()
      || participant.sourceIdentityId?.trim()
      || participant.id?.replace(/^human:/, '').trim();
    if (!displayLabel || !humanId) continue;
    const label = mentionHandleForLabel(displayLabel, humanId);
    const aliases = [...new Set([`@${displayLabel}`, `@${label}`])].sort((left, right) => right.length - left.length);
    for (const alias of aliases) {
      let startUtf16 = text.indexOf(alias);
      while (startUtf16 >= 0 && mentions.length < MAX_MENTIONS) {
        const before = text[startUtf16 - 1] ?? '';
        const after = text[startUtf16 + alias.length] ?? '';
        if (
          (!before || !/[\p{L}\p{N}._%+-]/u.test(before))
          && (!after || !/[\p{L}\p{N}._'-]/u.test(after))
          && !mentions.some((mention) => mention.startUtf16 === startUtf16)
        ) {
          mentions.push({
            label,
            targetKind: 'person',
            targetIdentityId: humanId.startsWith('human:') ? humanId : `human:${humanId}`,
            startUtf16,
            lengthUtf16: alias.length,
            displayText: alias,
            sourceHostId: participant.sourceHostId ?? null,
            nodeId: participant.sourceIdentityId ?? humanId,
            humanId,
            agentId: null,
            displayLabel,
          });
        }
        startUtf16 = text.indexOf(alias, startUtf16 + alias.length);
      }
    }
  }
  return mentions.sort((left, right) => (left.startUtf16 ?? 0) - (right.startUtf16 ?? 0));
}

export function mentionsForAllGroupMembers(
  text: string,
  conversation: MentionScopeConversation | null | undefined,
): MessageMention[] {
  if (!conversationHasGroupMentionScope(conversation)) return [];
  const targetIdentityId = groupMentionTargetIdentityId(
    conversation?.canonicalSessionId ?? conversation?.id,
  );
  if (!targetIdentityId) return [];

  const mentions: MessageMention[] = [];
  for (const match of text.matchAll(/@all/giu)) {
    const startUtf16 = match.index;
    const before = text[startUtf16 - 1] ?? '';
    const after = text[startUtf16 + match[0].length] ?? '';
    if (
      (!before || !/[\p{L}\p{N}._%+-]/u.test(before))
      && (!after || !/[\p{L}\p{N}_'-]/u.test(after))
    ) {
      mentions.push({
        label: ALL_GROUP_MENTION_LABEL,
        targetKind: 'all',
        targetIdentityId,
        startUtf16,
        lengthUtf16: match[0].length,
        displayText: match[0],
        displayLabel: 'All',
      });
    }
  }
  return mentions.slice(0, MAX_MENTIONS);
}

export function messageMentionsForSend(
  text: string,
  conversation: MentionScopeConversation | null | undefined,
  target: ResolvedMentionedCollaborationTarget | null,
) {
  return [...new Map([
    ...mentionsForConversationParticipants(text, conversation),
    ...mentionForCollaborationTarget(target, text),
    ...mentionsForAllGroupMembers(text, conversation),
  ].map((mention) => [`${mention.startUtf16}:${mention.lengthUtf16}`, mention])).values()]
    .sort((left, right) => (left.startUtf16 ?? 0) - (right.startUtf16 ?? 0))
    .slice(0, MAX_MENTIONS);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown, maxLength = MAX_MENTION_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maxLength ? cleaned : null;
}

function optionalString(value: unknown, maxLength = MAX_MENTION_ID_LENGTH) {
  if (value === null || value === undefined) return null;
  return cleanString(value, maxLength);
}

function optionalRangeValue(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function normalizedMessageMentions(value: unknown): MessageMention[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mentions = value.slice(0, MAX_MENTIONS).flatMap((item) => {
    const record = recordValue(item);
    const label = cleanString(record.label);
    if (!label) return [];

    const startUtf16 = optionalRangeValue(record.startUtf16);
    const lengthUtf16 = optionalRangeValue(record.lengthUtf16);
    const displayText = optionalString(record.displayText, MAX_MENTION_TEXT_LENGTH);
    const targetIdentityId = optionalString(record.targetIdentityId);
    const targetKind = normalizeCollaborationTargetKind(record.targetKind);
    const hasRangeField = (record.startUtf16 !== undefined && record.startUtf16 !== null)
      || (record.lengthUtf16 !== undefined && record.lengthUtf16 !== null);
    const invalidAllMention = targetKind === 'all' && !isVerifiedAllGroupMention({
      label,
      targetKind,
      targetIdentityId,
      startUtf16,
      lengthUtf16,
      displayText,
    });
    if (invalidAllMention || (hasRangeField && (
      startUtf16 === null
      || startUtf16 < 0
      || lengthUtf16 === null
      || lengthUtf16 < 1
      || !displayText?.startsWith('@')
      || lengthUtf16 !== displayText.length
      || !targetIdentityId
      || (targetKind !== 'agent' && targetKind !== 'person' && targetKind !== 'all')
      || (targetKind === 'agent' && !targetIdentityId.startsWith('agent:'))
      || (targetKind === 'person' && !targetIdentityId.startsWith('human:'))
    ))) return [];

    return [{
      label,
      targetKind,
      ...(targetIdentityId ? { targetIdentityId } : {}),
      ...(startUtf16 !== null ? { startUtf16 } : {}),
      ...(lengthUtf16 !== null ? { lengthUtf16 } : {}),
      ...(displayText ? { displayText } : {}),
      sourceHostId: compatibleSourceHostId(record) ?? null,
      nodeId: optionalString(record.nodeId),
      humanId: optionalString(record.humanId),
      agentId: optionalString(record.agentId),
      displayLabel: optionalString(record.displayLabel, MAX_MENTION_TEXT_LENGTH),
    }];
  });
  return mentions.length > 0 ? mentions : undefined;
}

function mentionAliases(mention: MessageMention) {
  const aliases = new Set([
    mention.displayText?.trim() ?? '',
    mention.displayLabel?.trim() ? `@${mention.displayLabel.trim()}` : '',
    mention.label.trim() ? `@${mention.label.trim()}` : '',
  ]);
  if (
    mention.targetKind === 'agent'
    && mention.label.replace(/\s+/g, '').toLowerCase() === 'mykordi'
  ) aliases.add('@My Kordi');
  aliases.delete('');
  return [...aliases].sort((left, right) => right.length - left.length);
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rangeMatchesText(text: string, mention: MessageMention) {
  const start = mention.startUtf16;
  const length = mention.lengthUtf16;
  const displayText = mention.displayText;
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(length)
    && (start ?? -1) >= 0
    && (length ?? 0) > 0
    && (start ?? 0) + (length ?? 0) <= text.length
    && text.slice(start!, start! + length!) === displayText;
}

export function messageMentionsForText(text: string, value: unknown): MessageMention[] | undefined {
  const mentions = normalizedMessageMentions(value);
  if (!mentions) return undefined;
  const occupied: Array<{ start: number; end: number }> = [];
  const resolved = mentions.flatMap((mention) => {
    if (rangeMatchesText(text, mention)) {
      const start = mention.startUtf16!;
      const end = start + mention.lengthUtf16!;
      if (occupied.some((range) => start < range.end && end > range.start)) return [];
      occupied.push({ start, end });
      return [mention];
    }

    for (const alias of mentionAliases(mention)) {
      for (const match of text.matchAll(new RegExp(escapedRegExp(alias), 'giu'))) {
        const start = match.index;
        const end = start + match[0].length;
        if (!occupied.some((range) => start < range.end && end > range.start)) {
          occupied.push({ start, end });
          return [{
            ...mention,
            startUtf16: start,
            lengthUtf16: match[0].length,
            displayText: text.slice(start, end),
          }];
        }
      }
    }
    return [];
  });
  return resolved.length > 0 ? resolved : undefined;
}
