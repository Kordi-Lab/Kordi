import { defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';
import type { DesktopCollaborationState, DesktopChatState } from '@/kordi-app/types';
import { possessiveScopedLabel, publicScopedAgentMentionHandle, rewriteLeadingFirstPersonAgentMention } from '@/lib/identityLabels';

import { mentionHandleForLabel, normalizeMentionLabel } from './mentionHandles';

export function scopedAgentLabel(ownerName: string | null | undefined, agentLabel: string | null | undefined, ownerIsSelf = false) {
  const label = agentLabel?.trim();
  if (!label) return null;
  const owner = ownerName?.trim();
  if (!owner) return label;
  return possessiveScopedLabel(owner, label, ownerIsSelf);
}

export function localCollaborationAgentLabels(collaborationState: DesktopCollaborationState | null) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  const ownerName = activeHost?.ownerName?.trim();
  const agentLabel = activeAgent?.label?.trim();
  return [
    agentLabel,
    scopedAgentLabel(ownerName, 'Kordi', true),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi', true),
    scopedAgentLabel(ownerName, 'Kordi'),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi'),
    activeAgent?.id,
    activeAgent?.nodeId,
  ];
}

function activeCollaborationHostAndAgent(collaborationState: DesktopCollaborationState | null) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  return { activeHost, activeAgent };
}

export function localAgentMentionLabels(state: DesktopChatState | null, collaborationState: DesktopCollaborationState | null) {
  const labels = [
    'Kordi',
    state?.localAgent?.label,
    ...localCollaborationAgentLabels(collaborationState),
    (() => {
      const parts = state?.localAgent?.workspaceRoot?.split(/[\\/]/).filter(Boolean) ?? [];
      return parts[parts.length - 1];
    })(),
  ];

  return Array.from(new Set(
    labels
      .map((label) => label?.trim())
      .filter((label): label is string => Boolean(label))
      .map((label) => mentionHandleForLabel(label, 'Kordi')),
  ));
}

export function mentionsLocalAgent(text: string, state: DesktopChatState | null, collaborationState: DesktopCollaborationState | null) {
  const afterAt = text.replace(/^\s*@/, '');
  return localAgentMentionLabels(state, collaborationState).some((label) => mentionTextStartsWithLabel(afterAt, label));
}

export function resolveMentionedLocalAgentTarget(
  text: string,
  state: DesktopChatState | null,
  collaborationState: DesktopCollaborationState | null,
) {
  if (!mentionsLocalAgent(text, state, collaborationState)) return null;
  const { activeHost, activeAgent } = activeCollaborationHostAndAgent(collaborationState);
  const ownerAccountId = activeHost?.humanId?.trim() || activeHost?.nodeId?.trim();
  if (!activeHost || !activeAgent || !ownerAccountId) return null;
  const displayLabel = state?.localAgent?.label?.trim() || activeAgent.label?.trim() || 'Kordi';
  const label = mentionHandleForLabel(displayLabel, activeAgent.id || ownerAccountId);
  const peer = {
    endpoint: activeHost.endpoint,
    nodeId: activeAgent.nodeId?.trim() || ownerAccountId,
    displayName: displayLabel,
    ownerName: activeHost.ownerName,
    runtime: activeAgent.runtime,
    humanId: ownerAccountId,
    agentId: defaultCloudAgentId(ownerAccountId),
  } as DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
  return {
    host: activeHost,
    peer,
    label,
    displayLabel,
    targetKind: 'agent' as const,
    requestText: stripLeadingAddressMentions(text, [displayLabel, label, 'Kordi', 'My Kordi']).trim(),
  };
}

function publicLocalAgentMentionLabel(collaborationState: DesktopCollaborationState | null) {
  const { activeHost, activeAgent } = activeCollaborationHostAndAgent(collaborationState);
  return publicScopedAgentMentionHandle(activeHost?.ownerName, activeAgent?.label || 'Kordi');
}

export function publicLocalAgentMentionText(text: string, collaborationState: DesktopCollaborationState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(null, collaborationState)
    .sort((left, right) => normalizeMentionLabel(right).length - normalizeMentionLabel(left).length);
  for (const label of labels) {
    const rest = leadingAddressRest(afterAt, label);
    if (rest === null) continue;
    return `${leading}@${publicLocalAgentMentionLabel(collaborationState)}${rest ? ` ${rest}` : ''}`;
  }
  return rewriteLeadingFirstPersonAgentMention(text, activeCollaborationHostAndAgent(collaborationState).activeHost?.ownerName, 'Kordi');
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

export function localHumanAddressLabels(collaborationState: DesktopCollaborationState | null) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  return [activeHost?.ownerName, activeHost?.displayName];
}

export function localAgentRuntimeText(text: string, state: DesktopChatState | null, collaborationState: DesktopCollaborationState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(state, collaborationState)
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
