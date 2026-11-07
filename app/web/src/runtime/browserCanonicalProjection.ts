import { browserSessionTitle } from '@web/runtime/browserSessionTitle';
import { browserCanonicalRowsMatch } from '@web/runtime/browserCanonicalChanges';
import type {
  AdoptCloudProfileIdentityRequest, AppendCanonicalMessageRequest, CanonicalIdentity,
  CanonicalMessagePage, CanonicalSessionCatalog, CanonicalSessionMessage, CanonicalSessionState,
  CanonicalTimelineCursor, OpenCanonicalSessionRequest, UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import { canonicalMessageCountsAsReadable } from '@/features/canonical/readModel/messageVisibility';

/** A device-local read model. These operations never send or acknowledge a cloud message. */
export function emptyBrowserCanonicalState(accountId: string, now = Date.now()): CanonicalSessionState {
  const humanIdentityId = `human:${accountId}`;
  return {
    storagePath: '',
    profile: { id: `web:${accountId}`, humanIdentityId, storageRoot: '', createdAtMs: now, updatedAtMs: now },
    identities: [{ id: humanIdentityId, kind: 'human', displayName: accountId, source: 'cloud',
      sourceIdentityId: accountId, humanId: accountId, avatarKey: accountId, createdAtMs: now, updatedAtMs: now }],
    sessions: [], participants: [], messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
  };
}

export function browserCanonicalCatalog(state: CanonicalSessionState): CanonicalSessionCatalog {
  const { messages, contextSnapshots, ...catalog } = state;
  const bySession = new Map<string, CanonicalSessionMessage[]>();
  for (const message of messages) {
    const rows = bySession.get(message.sessionId) ?? [];
    rows.push(message);
    bySession.set(message.sessionId, rows);
  }
  return { ...catalog, summaries: state.sessions.map(session => {
    const rows = bySession.get(session.id) ?? [];
    const readable = rows.filter(canonicalMessageCountsAsReadable).sort(compareTimeline);
    return { sessionId: session.id, messageCount: rows.length,
      latestMessage: readable[readable.length - 1] ?? null,
      contextSnapshotCount: contextSnapshots.filter(item => item.sessionId === session.id).length };
  }) };
}

function compareTimeline(left: CanonicalTimelineCursor, right: CanonicalTimelineCursor) {
  return left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum || left.id.localeCompare(right.id);
}

export function browserCanonicalPage(state: CanonicalSessionState, input: {
  sessionId: string; beforeSequenceNum?: number | null; limit?: number;
  timelineOrder?: boolean; beforeTimeline?: CanonicalTimelineCursor | null;
}): CanonicalMessagePage {
  const count = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  const rows = state.messages.filter(row => row.sessionId === input.sessionId
    && (input.beforeSequenceNum == null || row.sequenceNum < input.beforeSequenceNum)
    && (!input.beforeTimeline || compareTimeline(row, input.beforeTimeline) < 0))
    .sort(input.timelineOrder ? compareTimeline : (a, b) => a.sequenceNum - b.sequenceNum);
  const messages = rows.slice(-count);
  const sequences = messages.map(row => row.sequenceNum);
  return { sessionId: input.sessionId, messages, hasOlder: rows.length > count,
    oldestSequenceNum: sequences.length ? Math.min(...sequences) : null,
    newestSequenceNum: sequences.length ? Math.max(...sequences) : null,
    ...(input.timelineOrder ? { timelineOrder: true } : {}) };
}

export function upsertBrowserIdentity(state: CanonicalSessionState, request: UpsertCanonicalIdentityRequest, now = Date.now()): CanonicalIdentity {
  const id = request.id?.trim() || (request.humanId ? `human:${request.humanId}` : `${request.kind}:${crypto.randomUUID()}`);
  const previous = state.identities.find(row => row.id === id);
  const identity: CanonicalIdentity = { ...previous, ...request, id, source: request.source ?? previous?.source ?? 'cloud',
    displayName: request.displayName, avatarKey: request.avatarKey ?? previous?.avatarKey ?? id,
    createdAtMs: previous?.createdAtMs ?? now, updatedAtMs: now };
  if (previous && browserCanonicalRowsMatch(previous, identity)) return previous;
  state.identities = [...state.identities.filter(row => row.id !== id), identity];
  return identity;
}

export function adoptBrowserIdentity(state: CanonicalSessionState, request: AdoptCloudProfileIdentityRequest, now = Date.now()) {
  const previousIdentityId = state.profile.humanIdentityId ?? null;
  const identity = upsertBrowserIdentity(state, { ...request, id: `human:${request.accountId}`, kind: 'human',
    source: 'cloud', sourceIdentityId: request.accountId, humanId: request.accountId }, now);
  state.profile = { ...state.profile, displayName: request.displayName, humanIdentityId: identity.id, updatedAtMs: now };
  return { profile: state.profile, identity, previousIdentityId, groupSelfSessionIds: [] };
}

export function openBrowserCanonicalSession(state: CanonicalSessionState, request: OpenCanonicalSessionRequest, now = Date.now()) {
  const id = request.id?.trim() || crypto.randomUUID();
  const previous = state.sessions.find(row => row.id === id);
  const candidate = { ...previous, ...request, id, ...browserSessionTitle(previous, request, now),
    status: request.status ?? previous?.status ?? 'active', createdAtMs: previous?.createdAtMs ?? now, updatedAtMs: now };
  const session = previous && browserCanonicalRowsMatch(previous, candidate) ? previous : candidate;
  if (session !== previous) state.sessions = [...state.sessions.filter(row => row.id !== id), session];
  for (const identityId of new Set([request.createdByIdentityId, ...request.participantIdentityIds])) {
    const existing = state.participants.find(row => row.sessionId === id && row.identityId === identityId);
    if (existing) {
      if (existing.state !== 'active') state.participants = state.participants.map(row => row === existing ? { ...row, state: 'active' } : row);
      continue;
    }
    const identity = state.identities.find(row => row.id === identityId);
    state.participants = [...state.participants, { sessionId: id, identityId, state: 'active', addedAtMs: now,
      addedByIdentityId: request.createdByIdentityId,
      role: identityId === state.profile.humanIdentityId ? 'self'
        : identity?.kind === 'agent' ? (identity.ownerIdentityId === state.profile.humanIdentityId ? 'owned-agent' : 'external-agent') : 'person' }];
  }
  return { session, participants: state.participants.filter(row => row.sessionId === id) };
}

export function upsertBrowserMessage(state: CanonicalSessionState, request: AppendCanonicalMessageRequest, now = Date.now()) {
  const session = state.sessions.find(row => row.id === request.sessionId);
  if (!session) throw new Error('This conversation is not loaded. Refresh it before sending.');
  const previous = state.messages.find(row => (request.id && row.id === request.id)
    || (request.sourceEventId && request.sourceTransport && row.sourceEventId === request.sourceEventId && row.sourceTransport === request.sourceTransport));
  if (previous && previous.sessionId !== request.sessionId) throw new Error('A message cannot move between conversations.');
  const id = previous?.id ?? request.id?.trim() ?? crypto.randomUUID();
  const sequenceNum = previous?.sequenceNum ?? state.messages.filter(row => row.sessionId === request.sessionId)
    .reduce((max, row) => Math.max(max, row.sequenceNum), 0) + 1;
  const message: CanonicalSessionMessage = { ...previous, ...request, id, sequenceNum,
    status: request.status ?? previous?.status ?? 'sent', createdAtMs: request.createdAtMs ?? previous?.createdAtMs ?? now,
    updatedAtMs: now };
  if (previous && browserCanonicalRowsMatch(previous, message)) return previous;
  state.messages = [...state.messages.filter(row => row.id !== id), message];
  session.lastMessageAtMs = Math.max(session.lastMessageAtMs ?? 0, message.createdAtMs);
  session.updatedAtMs = Math.max(session.updatedAtMs, now);
  return message;
}

export function browserCanonicalCloudMessageId(message: CanonicalSessionMessage) {
  const source = message.sourceTransport;
  if (source === 'cloud-self-agent' || source === 'canonical-fork-snapshot') return message.sourceEventId;
  if (source === 'cloud-group' || source === 'cloud-group-agent') return message.sourceEventId?.replace(`${source}:`, '').split(':')[0];
  return null;
}
