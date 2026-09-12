import type { CloudMessage } from './authClient';
import { compareCloudMessages } from './cloudMessageMerge';
import type { CanonicalSessionMessage } from '@/kordi-app/types';

export const NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER = 64;
export const NATIVE_RENDERER_MESSAGE_CACHE_ROWS = 4_096;
export const NATIVE_RENDERER_MESSAGE_CACHE_BYTES = 16 * 1024 * 1024;
const messageBytes = new WeakMap<CloudMessage, number>();
const EMPTY_IDS: ReadonlySet<string> = new Set();
type RetentionResult = {
  limit: number; maxRows: number; maxBytes: number;
  activeSessionId: string | null | undefined; requiredMessageIds: ReadonlySet<string>;
  value: Record<string, CloudMessage[]>;
};
// Cache by immutable input with weak keys; never hold the full input behind a
// compact result. No-op syncs can then reuse the retained window directly.
const retainedWindows = new WeakMap<Record<string, CloudMessage[]>, RetentionResult>();

// Loaded canonical pages can include older messages being edited or receiving
// receipts. Keep their wire updates available to the compatibility projectors.
export function canonicalRendererMessageIds(messages: readonly CanonicalSessionMessage[] = []) {
  const ids = new Set<string>();
  for (const message of messages) {
    const transport = message.sourceTransport ?? '';
    if (!transport.startsWith('cloud') && transport !== 'canonical-fork-snapshot') continue;
    ids.add(message.id);
    const source = message.sourceEventId ?? '';
    const prefix = `${transport}:`;
    const sourceId = transport.startsWith('cloud-group') && source.startsWith(prefix)
      ? source.slice(prefix.length).split(':', 1)[0] : source;
    if (sourceId) ids.add(sourceId);
    const content = message.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) continue;
    for (const field of ['cloudReactionTargetMessageId', 'cloudGroupMessageId']) {
      const id = (content as Record<string, unknown>)[field];
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

// Conservative payload accounting, not a claim about exact JavaScript heap
// size. Weak keys avoid retaining messages solely for their cached estimate.
export function estimateCloudMessageBytes(message: CloudMessage): number {
  const cached = messageBytes.get(message);
  if (cached !== undefined) return cached;
  let bytes = 0;
  const pending: unknown[] = [message];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += 16 + value.length * 2;
    else if (value && typeof value === 'object') {
      if (visited.has(value)) continue;
      visited.add(value);
      bytes += 32;
      for (const [key, child] of Object.entries(value)) {
        bytes += 8 + key.length * 2;
        pending.push(child);
      }
    } else bytes += 8;
  }
  messageBytes.set(message, bytes);
  return bytes;
}

export function compactNativeCloudMessagesByPeer(
  messagesByPeer: Record<string, CloudMessage[]>,
  limit = NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
  activeSessionId?: string | null,
  budget = { maxRows: NATIVE_RENDERER_MESSAGE_CACHE_ROWS, maxBytes: NATIVE_RENDERER_MESSAGE_CACHE_BYTES },
  requiredMessageIds: ReadonlySet<string> = EMPTY_IDS,
) {
  const cached = retainedWindows.get(messagesByPeer);
  if (cached && cached.limit === limit && cached.maxRows === budget.maxRows && cached.maxBytes === budget.maxBytes
    && cached.activeSessionId === activeSessionId && cached.requiredMessageIds === requiredMessageIds) return cached.value;
  const rowLimit = Math.max(0, Math.floor(limit));
  const kept = new Map<string, Set<CloudMessage>>();
  const orderedByPeer = new Map<string, CloudMessage[]>();
  const candidates: Array<{ peerId: string; message: CloudMessage; active: boolean }> = [];
  let retainedRows = 0;
  let retainedBytes = 0;
  const keep = (peerId: string, message: CloudMessage) => {
    const rows = kept.get(peerId)!;
    if (rows.has(message)) return;
    rows.add(message);
    retainedRows += 1;
    retainedBytes += estimateCloudMessageBytes(message);
  };
  for (const [peerId, messages] of Object.entries(messagesByPeer)) {
    kept.set(peerId, new Set());
    const ordered = [...messages].sort(compareCloudMessages);
    orderedByPeer.set(peerId, ordered);
    const heads = new Map<string, CloudMessage>();
    const routes = new Map<string, CloudMessage>();
    const active: CloudMessage[] = [];
    for (const message of ordered) {
      const sessionId = message.sessionId?.trim() || message.conversationId?.trim() || peerId;
      const pending = message.direction === 'outgoing' && !message.deliveredAt;
      if (!pending && message.messageKind !== 'agent-model-change') heads.set(sessionId, message);
      if (message.messageKind === 'agent-model-change') routes.set(sessionId, message);
      if (pending || requiredMessageIds.has(message.messageId)) keep(peerId, message);
      if (activeSessionId && sessionId === activeSessionId) active.push(message);
    }
    // These are correctness pins, not disposable history. Their size is a
    // separate floor if a large catalog or pending outbox exceeds the budget.
    for (const message of heads.values()) keep(peerId, message);
    for (const message of routes.values()) keep(peerId, message);
    const activeTail = new Set(rowLimit ? active.slice(-rowLimit) : []);
    const recent = new Set([...(rowLimit ? ordered.slice(-rowLimit) : []), ...activeTail]);
    for (const message of recent) {
      if (!kept.get(peerId)!.has(message)) candidates.push({ peerId, message, active: activeTail.has(message) });
    }
  }
  candidates.sort((a, b) => Number(b.active) - Number(a.active)
    || b.message.createdAt.localeCompare(a.message.createdAt));
  for (const { peerId, message } of candidates) {
    const bytes = estimateCloudMessageBytes(message);
    if (retainedRows >= budget.maxRows || retainedBytes + bytes > budget.maxBytes) continue;
    keep(peerId, message);
  }
  let changed = false;
  const next: Record<string, CloudMessage[]> = {};
  for (const [peerId, ordered] of orderedByPeer) {
    const rows = ordered.filter((message) => kept.get(peerId)!.has(message));
    const current = messagesByPeer[peerId];
    const unchanged = current.length === rows.length && current.every((message, index) => message === rows[index]);
    next[peerId] = unchanged ? current : rows;
    changed ||= !unchanged;
  }
  const value = changed ? next : messagesByPeer;
  const result = { limit, maxRows: budget.maxRows, maxBytes: budget.maxBytes, activeSessionId, requiredMessageIds, value };
  retainedWindows.set(messagesByPeer, result);
  retainedWindows.set(value, result);
  return value;
}
