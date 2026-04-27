import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import type {
  ConversationBridgeTarget,
  DesktopBridgeState,
  DesktopChatState,
  MessageMention,
} from '@/kordi-app/types';

import type { ResolvedMentionedBridgeTarget } from './types';

export function mentionForBridgeTarget(target: ResolvedMentionedBridgeTarget | null): MessageMention[] {
  if (!target) return [];
  return [{
    label: target.label,
    targetKind: target.targetKind,
    bridgeHostId: target.host.id,
    nodeId: target.peer.nodeId,
    humanId: target.peer.humanId ?? null,
    agentId: target.peer.agentId ?? null,
  }];
}

export function outreachIdentityForBridgeTarget(target: ResolvedMentionedBridgeTarget) {
  return {
    targetDisplayName: target.label,
    targetOwnerName: target.peer.ownerName ?? null,
    targetRuntime: target.peer.runtime,
    targetHumanId: target.peer.humanId ?? null,
    targetAgentId: target.peer.agentId ?? null,
  };
}

export function mentionedPersonIsActiveBridgeTarget(
  target: ResolvedMentionedBridgeTarget,
  activeTarget?: ConversationBridgeTarget | null,
) {
  if (target.targetKind !== 'bridge-person' || !activeTarget) return false;
  if (target.peer.humanId && activeTarget.humanId && target.peer.humanId === activeTarget.humanId) return true;
  return target.peer.nodeId === activeTarget.nodeId;
}


export function normalizeMentionLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function scopedAgentLabel(ownerName: string | null | undefined, agentLabel: string | null | undefined) {
  const label = agentLabel?.trim();
  if (!label) return null;
  const owner = ownerName?.trim();
  if (!owner) return label;
  const prefix = `${owner}'s `;
  return label.startsWith(prefix) ? label : `${prefix}${label}`;
}

export function localBridgeAgentLabels(bridgeState: DesktopBridgeState | null) {
  const activeHost = bridgeState?.hosts.find((host) => host.id === bridgeState.activeHostId)
    ?? bridgeState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  const ownerName = activeHost?.ownerName?.trim();
  const hostDisplayName = activeHost?.displayName?.trim();
  const agentLabel = activeAgent?.label?.trim();
  return [
    hostDisplayName,
    agentLabel,
    scopedAgentLabel(ownerName, 'Kordi'),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi'),
    activeAgent?.id,
    activeAgent?.nodeId,
  ];
}

export function localAgentMentionLabels(state: DesktopChatState | null, bridgeState: DesktopBridgeState | null) {
  return [
    'Kordi',
    state?.localAgent?.label,
    ...localBridgeAgentLabels(bridgeState),
    (() => {
      const parts = state?.localAgent?.workspaceRoot?.split(/[\\/]/).filter(Boolean) ?? [];
      return parts[parts.length - 1];
    })(),
  ]
    .map((label) => label?.trim())
    .filter((label): label is string => Boolean(label));
}

export function mentionsLocalAgent(text: string, state: DesktopChatState | null, bridgeState: DesktopBridgeState | null) {
  const afterAt = text.replace(/^\s*@/, '');
  return localAgentMentionLabels(state, bridgeState).some((label) => mentionTextStartsWithLabel(afterAt, label));
}

export function leadingAddressRest(textAfterAt: string, label: string) {
  const cleanLabel = label.trim();
  if (!cleanLabel) return null;
  const candidate = textAfterAt.slice(0, cleanLabel.length);
  if (candidate.toLocaleLowerCase() !== cleanLabel.toLocaleLowerCase()) return null;
  let rest = textAfterAt.slice(cleanLabel.length);
  const next = rest[0];
  if (next && !/[\s:;,.!?—-]/.test(next)) return null;
  rest = rest.trimStart();
  if (/^[:;,.!?—-]/.test(rest)) {
    rest = rest.slice(1).trimStart();
  }
  return rest;
}

export function stripLeadingAddressMentions(text: string, labels: Array<string | null | undefined>) {
  let current = text.trimStart();
  const sortedLabels = Array.from(new Set(
    labels
      .map((label) => label?.trim())
      .filter((label): label is string => Boolean(label)),
  )).sort((left, right) => right.length - left.length);

  while (current.startsWith('@')) {
    const afterAt = current.slice(1);
    const rest = sortedLabels.map((label) => leadingAddressRest(afterAt, label)).find((value) => value !== null);
    if (rest === undefined || rest === null || rest.trim() === current.trim() || rest.trim().length === 0) break;
    current = rest.trimStart();
  }

  return current;
}

export function localHumanAddressLabels(bridgeState: DesktopBridgeState | null) {
  const activeHost = bridgeState?.hosts.find((host) => host.id === bridgeState.activeHostId)
    ?? bridgeState?.hosts[0]
    ?? null;
  return [activeHost?.ownerName, activeHost?.displayName];
}

export function localAgentRuntimeText(text: string, state: DesktopChatState | null, bridgeState: DesktopBridgeState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(state, bridgeState)
    .filter((label) => normalizeMentionLabel(label) !== normalizeMentionLabel('Kordi'))
    .sort((left, right) => normalizeMentionLabel(right).length - normalizeMentionLabel(left).length);
  for (const label of labels) {
    if (!mentionTextStartsWithLabel(afterAt, label)) continue;
    let mentionEnd = leading.length + 1 + label.length;
    if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
      mentionEnd += 1;
    }
    return `${leading}@Kordi${text.slice(mentionEnd)}`;
  }
  return text;
}


export function mentionTextStartsWithLabel(text: string, label: string) {
  const normalizedText = normalizeMentionLabel(text);
  const normalizedLabel = normalizeMentionLabel(label);
  if (normalizedText === normalizedLabel) return true;
  if (!normalizedText.startsWith(normalizedLabel)) return false;
  const next = normalizedText.slice(normalizedLabel.length, normalizedLabel.length + 1);
  return !next || /[\s:;,.!?—-]/.test(next);
}

export function resolveMentionedBridgeTarget(text: string, bridgeState: DesktopBridgeState | null) {
  if (!bridgeState) return null;
  const mentionMatches = Array.from(text.matchAll(/(^|\s)@/g));
  if (mentionMatches.length === 0) return null;

  type MentionCandidate = {
    host: DesktopBridgeState['hosts'][number];
    peer: DesktopBridgeState['hosts'][number]['visiblePeers'][number];
    label: { label: string; normalized: string };
    targetKind: 'bridge-person' | 'bridge-agent';
  };

  const candidates = bridgeState.hosts.flatMap((host) => host.visiblePeers.flatMap((peer) => {
    const isAgent = isBridgeAgentRuntime(peer.runtime);
    const seen = new Set<string>();
    const labels: MentionCandidate[] = [];
    const pushLabel = (value: string | null | undefined, targetKind: MentionCandidate['targetKind']) => {
      const label = value?.trim();
      if (!label) return;
      const dedupeKey = `${targetKind}:${normalizeMentionLabel(label)}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      labels.push({
        host,
        peer,
        targetKind,
        label: { label, normalized: normalizeMentionLabel(label) },
      });
    };

    if (isAgent && peer.humanId?.trim()) {
      pushLabel(peer.ownerName, 'bridge-person');
    }
    pushLabel(peer.displayName, isAgent ? 'bridge-agent' : 'bridge-person');
    if (!isAgent) {
      pushLabel(peer.ownerName, 'bridge-person');
    }
    pushLabel(peer.nodeId, isAgent ? 'bridge-agent' : 'bridge-person');
    return labels;
  }));

  for (const mention of mentionMatches) {
    const mentionStart = (mention.index ?? 0) + mention[1].length;
    const rawAfterAt = text.slice(mentionStart + 1);
    const leadingWhitespace = rawAfterAt.length - rawAfterAt.trimStart().length;
    const afterAt = rawAfterAt.trimStart();
    if (!afterAt) continue;
    const match = candidates
      .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.label.label))
      .sort((left, right) => right.label.normalized.length - left.label.normalized.length)[0];
    if (!match) continue;

    let mentionEnd = mentionStart + 1 + leadingWhitespace + match.label.label.length;
    if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
      mentionEnd += 1;
    }
    const requestText = `${text.slice(0, mentionStart)}${text.slice(mentionEnd)}`.replace(/\s+/g, ' ').trim();
    if (!requestText) continue;

    return {
      host: match.host,
      peer: match.peer,
      label: match.label.label,
      targetKind: match.targetKind,
      requestText,
    };
  }

  return null;
}

export function insertMentionIntoDraft(current: string, label: string) {
  const mention = `@${label}`;
  const match = /(^|\s)@([^@\n\r]*)$/.exec(current);
  if (match && typeof match.index === 'number') {
    return `${current.slice(0, match.index)}${match[1]}${mention} `;
  }
  if (!current.trim()) {
    return `${mention} `;
  }
  return `${mention} ${current}`;
}
