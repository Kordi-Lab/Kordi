import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';

const RUNNING_STATUSES = new Set(['sending', 'pending', 'queued', 'processing', 'streaming', 'running']);
const SNAPSHOT_PREFIX = 'fork-snapshot:';

function snapshotSource(
  message: CanonicalSessionMessage,
  messageById: ReadonlyMap<string, CanonicalSessionMessage>,
) {
  // `fork-snapshot:<fork>:<source session>:<source message>`; ids may hold colons.
  const prefix = `${SNAPSHOT_PREFIX}${message.sessionId}:`;
  const rest = message.sourceEventId?.startsWith(prefix) ? message.sourceEventId.slice(prefix.length) : '';
  for (let split = rest.indexOf(':'); split > 0; split = rest.indexOf(':', split + 1)) {
    const source = messageById.get(rest.slice(split + 1));
    if (source?.sessionId === rest.slice(0, split)) return source;
  }
  return null;
}

function sameReplyState(left: CanonicalSessionMessage, right: CanonicalSessionMessage) {
  // Rows are parsed separately, so their content objects never share identity.
  return left.status === right.status && left.contentText === right.contentText
    && (left.contentHash && right.contentHash
      ? left.contentHash === right.contentHash
      : JSON.stringify(left.content) === JSON.stringify(right.content));
}

/**
 * A fork copies its source's history when it is made. A reply that was still
 * running then shows its source row's progress until it finishes, as the
 * desktop store records on save, so the fork never shows it working forever.
 */
export function followRunningForkSnapshots<State extends CanonicalSessionState | null>(state: State): State {
  if (!state) return state;
  let messageById: Map<string, CanonicalSessionMessage> | null = null;
  let changed = false;
  const messages = state.messages.map((message) => {
    if (message.sourceTransport !== 'canonical-fork-snapshot' || !RUNNING_STATUSES.has(message.status)) return message;
    messageById ??= new Map(state.messages.map((row) => [row.id, row]));
    let source = snapshotSource(message, messageById);
    // A fork of a fork follows the chain to the reply that is actually running.
    for (let depth = 0; source && depth < 8 && source.sourceTransport === 'canonical-fork-snapshot'
      && RUNNING_STATUSES.has(source.status); depth += 1) {
      const next = snapshotSource(source, messageById);
      if (!next) break;
      source = next;
    }
    if (!source || sameReplyState(source, message)) return message;
    changed = true;
    return {
      ...message,
      contentText: source.contentText,
      content: source.content,
      status: source.status,
      updatedAtMs: Math.max(message.updatedAtMs, source.updatedAtMs),
    };
  });
  return changed ? { ...state, messages } : state;
}
