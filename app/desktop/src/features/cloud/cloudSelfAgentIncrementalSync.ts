import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import type { CloudMessage, CloudSessionForkSummary } from './authClient';

/**
 * Incremental Ask Agent canonical sync: only conversations whose Cloud
 * messages or stored rows changed are planned again, and a write the store
 * has already handled is not sent again. Planning every conversation took
 * seconds on the main thread and rewrote rows the store would not change,
 * so a steady state never wrote nothing.
 */

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
        .map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item
  ));
}

/** Per conversation: its Cloud messages and its stored rows, as one comparable string. */
export function cloudSelfAgentSessionFingerprints(
  messages: readonly CloudMessage[],
  state: CanonicalSessionState,
  isGroupRow: (messageId: string) => boolean = () => false,
  /** What else one conversation's plan reads, such as its title or fork. */
  sessionInputs: (sessionId: string) => unknown = () => null,
): Map<string, string> {
  const wire = new Map<string, string[]>();
  for (const message of messages) {
    const sessionId = message.sessionId?.trim() ?? '';
    const parts = wire.get(sessionId) ?? [];
    parts.push(`${message.messageId}:${message.version ?? ''}:${message.body.length}:${message.attachments?.length ?? -1}${isGroupRow(message.messageId) ? ':g' : ''}`);
    wire.set(sessionId, parts);
  }
  const stored = new Map<string, string[]>();
  for (const row of state.messages) {
    if (!wire.has(row.sessionId)) continue;
    const parts = stored.get(row.sessionId) ?? [];
    parts.push(`${row.id}:${row.updatedAtMs}:${row.status}`);
    stored.set(row.sessionId, parts);
  }
  return new Map([...wire].map(([sessionId, parts]) => [
    sessionId,
    `${parts.join(',')}|${(stored.get(sessionId) ?? []).join(',')}|${stableJson(sessionInputs(sessionId) ?? null)}`,
  ]));
}

/**
 * The conversations to plan again, or null for all of them. A fork and its
 * parent are planned together, since a fork's snapshot rows are found by
 * comparing it with its parent.
 */
export function changedCloudSelfAgentSessionIds(
  current: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string> | null,
  forksBySessionId: Readonly<Record<string, CloudSessionForkSummary>> = {},
): Set<string> | null {
  if (!previous) return null;
  const changed = new Set([...current].flatMap(([sessionId, fingerprint]) => (
    previous.get(sessionId) === fingerprint ? [] : [sessionId]
  )));
  for (const fork of Object.values(forksBySessionId)) {
    const child = fork.forkSessionId?.trim() ?? '';
    const parent = fork.parentSessionId?.trim() ?? '';
    if (changed.has(child) || changed.has(parent)) {
      if (child) changed.add(child);
      if (parent) changed.add(parent);
    }
  }
  return changed;
}

/** What was last sent for a row, and the row the store answered with. */
export type CloudSelfAgentSentRequestMemo = Map<string, { request: string; storedUpdatedAtMs: number }>;

function sameStoredMessage(row: CanonicalSessionMessage, request: AppendCanonicalMessageRequest) {
  return row.sessionId === request.sessionId
    && row.senderIdentityId === request.senderIdentityId
    && row.senderRole === request.senderRole
    && row.messageKind === request.messageKind
    && row.contentText === request.contentText
    && (row.parentMessageId ?? null) === (request.parentMessageId ?? null)
    && row.status === (request.status ?? row.status)
    && (request.createdAtMs == null || row.createdAtMs === request.createdAtMs)
    && (row.sourceTransport ?? null) === (request.sourceTransport ?? null)
    && (row.sourceEventId ?? null) === (request.sourceEventId ?? null)
    // Stored content comes back with sorted keys; compare without key order.
    && stableJson(row.content ?? null) === stableJson(request.content ?? null);
}

/**
 * Whether `request` would change nothing: the row already holds it, or the
 * same request was sent before and the store answered with the row as it is
 * now (the store keeps an agent reply's position and refuses some changes).
 */
export function cloudSelfAgentRequestIsSettled(
  request: AppendCanonicalMessageRequest,
  row: CanonicalSessionMessage | undefined,
  memo?: CloudSelfAgentSentRequestMemo,
): boolean {
  const sent = request.id ? memo?.get(request.id) : undefined;
  // A row outside the loaded transcript window: the store already answered this exact request.
  if (!row) return Boolean(sent && sent.request === stableJson(request));
  if (sameStoredMessage(row, request)) return true;
  // The row is as the store answered, or the loaded copy is older than that answer.
  return Boolean(sent && sent.request === stableJson(request) && row.updatedAtMs <= sent.storedUpdatedAtMs);
}

export function recordSentCloudSelfAgentRequests(
  memo: CloudSelfAgentSentRequestMemo,
  requests: readonly AppendCanonicalMessageRequest[],
  storedRows: readonly CanonicalSessionMessage[],
) {
  // The store answers each request in order, sometimes with a row under another id.
  requests.forEach((request, index) => {
    const stored = storedRows[index];
    if (request.id && stored) memo.set(request.id, { request: stableJson(request), storedUpdatedAtMs: stored.updatedAtMs });
  });
}

/** What each conversation looked like when it last settled, for one account and set of plan inputs. */
export type CloudSelfAgentSettledSessions = {
  accountId: string;
  inputs: readonly unknown[];
  bySession: Map<string, string>;
};

/**
 * The Cloud messages to plan this round: those of conversations that changed
 * since they last settled, or all of them when an input shared by every
 * conversation changed. `markSettled` records the planned conversations once
 * their plan is stored, or was empty.
 */
export function selectCloudSelfAgentMessagesToPlan({
  settled,
  accountId,
  inputs,
  messages,
  state,
  forksBySessionId,
  titlesBySessionId,
  isGroupRow,
}: {
  settled: { current: CloudSelfAgentSettledSessions | null };
  accountId: string;
  /** Inputs every conversation's plan reads; compared by value. */
  inputs: readonly unknown[];
  messages: readonly CloudMessage[];
  state: CanonicalSessionState;
  forksBySessionId?: Readonly<Record<string, CloudSessionForkSummary>>;
  titlesBySessionId?: Readonly<Record<string, unknown>>;
  isGroupRow?: (messageId: string) => boolean;
}) {
  inputs = inputs.map((input) => stableJson(input ?? null));
  const last = settled.current;
  const previous = last?.accountId === accountId && last.inputs.length === inputs.length
    && last.inputs.every((input, index) => input === inputs[index]) ? last.bySession : null;
  // A title or fork belongs to its conversation, so changing one replans only that conversation.
  const forksByMember = new Map<string, unknown[]>();
  for (const fork of Object.values(forksBySessionId ?? {})) {
    for (const member of [fork.forkSessionId, fork.parentSessionId]) {
      const id = member?.trim();
      if (id) forksByMember.set(id, [...forksByMember.get(id) ?? [], fork]);
    }
  }
  const fingerprints = cloudSelfAgentSessionFingerprints(messages, state, isGroupRow, (sessionId) => [
    titlesBySessionId?.[sessionId] ?? null, forksByMember.get(sessionId) ?? null,
  ]);
  const changed = changedCloudSelfAgentSessionIds(fingerprints, previous, forksBySessionId);
  return {
    sessionIds: changed,
    messages: changed ? messages.filter((message) => changed.has(message.sessionId?.trim() ?? '')) : [...messages],
    markSettled() {
      const bySession = new Map(previous ?? []);
      for (const [sessionId, fingerprint] of fingerprints) {
        if (!changed || changed.has(sessionId)) bySession.set(sessionId, fingerprint);
      }
      settled.current = { accountId, inputs, bySession };
    },
  };
}
