import type { Contact } from '@/kordi-app/types';

import type { CloudMessage } from './authClient';
import { parseCloudAgentCancel, parseCloudAgentResponse } from './cloudAgentMessages';
import { isSystemCloudAgentContact } from './cloudContactPeers';
import { cloudDirectMessageTargetCloudAgentId } from './cloudDirectMessages';

function requestIdsForSystemAgents(
  messages: readonly CloudMessage[],
  targetAgentIds: ReadonlySet<string>,
): Set<string> {
  return new Set(messages
    .filter((message) => {
      const targetAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
      return Boolean(targetAgentId && targetAgentIds.has(targetAgentId));
    })
    .map((message) => message.messageId));
}

export function messagesForSystemAgent(
  contact: Contact,
  messages: readonly CloudMessage[],
): readonly CloudMessage[] {
  const targetAgentId = contact.sourceAgentId?.trim() ?? '';
  if (!targetAgentId) return [];
  const requestIds = requestIdsForSystemAgents(messages, new Set([targetAgentId]));
  return messages.filter((message) => {
    if (cloudDirectMessageTargetCloudAgentId(message.body) === targetAgentId) return true;
    const responseRequestId = parseCloudAgentResponse(message.body)?.requestId.trim();
    if (responseRequestId && requestIds.has(responseRequestId)) return true;
    const cancelRequestId = parseCloudAgentCancel(message.body)?.requestId.trim();
    return Boolean(cancelRequestId && requestIds.has(cancelRequestId));
  });
}

export function messagesWithoutSystemAgents(
  messages: readonly CloudMessage[],
  targetAgentIds: ReadonlySet<string>,
): readonly CloudMessage[] {
  if (targetAgentIds.size === 0) return messages;
  const requestIds = requestIdsForSystemAgents(messages, targetAgentIds);
  return messages.filter((message) => {
    const targetAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
    if (targetAgentId && targetAgentIds.has(targetAgentId)) return false;
    const responseRequestId = parseCloudAgentResponse(message.body)?.requestId.trim();
    if (responseRequestId && requestIds.has(responseRequestId)) return false;
    const cancelRequestId = parseCloudAgentCancel(message.body)?.requestId.trim();
    return !(cancelRequestId && requestIds.has(cancelRequestId));
  });
}

export function systemAgentIdsByPeer(contacts: readonly Contact[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const contact of contacts) {
    if (!isSystemCloudAgentContact(contact)) continue;
    const peerId = contact.sourceParticipantId || contact.id.replace(/^cloud:/, '');
    const targetAgentId = contact.sourceAgentId?.trim();
    if (!targetAgentId) continue;
    const targetIds = result.get(peerId) ?? new Set<string>();
    targetIds.add(targetAgentId);
    result.set(peerId, targetIds);
  }
  return result;
}

export function cloudConversationContactKey(contact: Contact): string {
  if (isSystemCloudAgentContact(contact)) return `system-agent:${contact.sourceAgentId}`;
  return `account:${contact.sourceParticipantId || contact.id.replace(/^cloud:/, '')}`;
}

export function messagesForCloudContact(
  contact: Contact,
  messages: readonly CloudMessage[],
  targetAgentIds: ReadonlySet<string>,
): readonly CloudMessage[] {
  return isSystemCloudAgentContact(contact)
    ? messagesForSystemAgent(contact, messages)
    : messagesWithoutSystemAgents(messages, targetAgentIds);
}
