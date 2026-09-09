import type { DesktopCollaborationConversation, DesktopCollaborationHost } from '@/kordi-app/types';
import { COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS } from './collaborationProcessingState';
import { mapCollaborationConversationToViewModel } from './transcript';

/** Reuse unchanged chat projections across sends in other conversations. */
export function createCollaborationConversationMapper() {
  const hostKeys = new WeakMap<DesktopCollaborationHost, string>();
  const cache = new WeakMap<DesktopCollaborationConversation, {
    hostKey: string;
    localAgentLabel: string;
    nativeShell: boolean;
    computedAt: number;
    expiresAt: number;
    value: ReturnType<typeof mapCollaborationConversationToViewModel>;
  }>();
  return (
    conversation: DesktopCollaborationConversation,
    host: DesktopCollaborationHost | undefined,
    localAgentLabel: string,
    nowMs = Date.now(),
  ) => {
    // Cloud snapshots recreate the host even when its presentation is unchanged.
    let hostKey = host ? hostKeys.get(host) : '';
    if (host && hostKey === undefined) {
      hostKey = JSON.stringify(host);
      hostKeys.set(host, hostKey);
    }
    const nativeShell = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
    const previous = cache.get(conversation);
    if (previous && previous.hostKey === hostKey && previous.localAgentLabel === localAgentLabel
      && previous.nativeShell === nativeShell && nowMs >= previous.computedAt && nowMs < previous.expiresAt) {
      return previous.value;
    }
    const value = mapCollaborationConversationToViewModel(conversation, host, localAgentLabel, nowMs);
    // Pending replies are time-sensitive. Recompute at the first possible expiry,
    // including after a clock adjustment, even when no new message has arrived.
    let expiresAt = Number.POSITIVE_INFINITY;
    const includeExpiry = (timestampMs: number | undefined) => {
      if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) return;
      const expiry = timestampMs + COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS;
      if (expiry > nowMs) expiresAt = Math.min(expiresAt, expiry);
    };
    for (const message of conversation.messages) includeExpiry(message.timestampMs);
    includeExpiry(conversation.outreach?.updatedAtMs || conversation.outreach?.createdAtMs);
    cache.set(conversation, { hostKey: hostKey ?? '', localAgentLabel, nativeShell, computedAt: nowMs, expiresAt, value });
    return value;
  };
}
