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
    const source = snapshotSource(message, messageById);
    if (!source || (source.status === message.status && source.contentText === message.contentText
      && source.content === message.content)) return message;
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
