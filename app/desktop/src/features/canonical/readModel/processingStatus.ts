import type {
  CanonicalSessionMessage
} from '@/kordi-app/types';
import {
  contentRecord,
  isProcessingPlaceholderText,
  stringValue
} from "./messageMapping";

export function isOwnedAgentTurn(message: CanonicalSessionMessage) {
  return message.senderRole === 'owned-agent' && message.messageKind === 'agent-turn';
}

export function isLegacyCollaborationAgentProcessingPlaceholder(message: CanonicalSessionMessage) {
  return (message.senderRole === 'owned-agent' || message.senderRole === 'external-agent')
    && message.messageKind === 'agent-turn'
    && (isProcessingPlaceholderText(message.contentText)
      || (!message.contentText.trim() && isActiveProcessingStatus(message)));
}

export function isStaleableProcessingPlaceholder(message: CanonicalSessionMessage) {
  return (message.sourceTransport === 'desktop-bridge-session-relay'
    || message.sourceTransport === 'desktop-bridge-parent'
    || message.sourceTransport === 'cloud-group-agent'
    || message.sourceTransport === 'cloud-group-agent-offline')
    && isLegacyCollaborationAgentProcessingPlaceholder(message);
}

export const LEGACY_COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS = 10 * 60 * 1_000;

export function isActiveProcessingStatus(message: CanonicalSessionMessage) {
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  const status = message.status.trim().toLowerCase();
  return deliveryState === 'processing' || status === 'processing';
}

export function isAgedLegacyCollaborationProcessingPlaceholder(message: CanonicalSessionMessage) {
  if (!isStaleableProcessingPlaceholder(message)) return false;
  if (!isActiveProcessingStatus(message)) return true;

  return Date.now() - message.createdAtMs > LEGACY_COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS;
}

export function isPureLegacyCollaborationAgentStatusRow(message: CanonicalSessionMessage) {
  if (message.sourceTransport !== 'desktop-bridge-session-relay') return false;
  if (!isOwnedAgentTurn(message)) return false;
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  // Legacy `processing` fanout duplicates the sender's local turn until assistant text streams;
  // cancelled and failed rows are terminal status markers.
  return deliveryState === 'processing'
    || deliveryState === 'cancelled'
    || deliveryState === 'processing_failed';
}
