import { sessionTitleMetadata } from '@/features/chat/sessionTitlePolicy';
import type {
  AddCanonicalGroupMembersRequest, AddCanonicalSessionParticipantsRequest, AdoptCloudProfileIdentityRequest, AppendCanonicalMessageRequest,
  CanonicalSessionState, CreateCanonicalDelegatedExchangeRequest, MarkCanonicalSessionReadRequest,
  OpenCanonicalSessionRequest, RemoveCanonicalSessionParticipantRequest, RenameCanonicalSessionRequest,
  SetCanonicalSessionParticipantRoleRequest, UpdateCanonicalMessageDeliveryRequest, UpdateCanonicalPresenceRequest,
  UpdateCanonicalSessionMetadataRequest, UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import { adoptBrowserIdentity, browserCanonicalCatalog, browserCanonicalCloudMessageId, browserCanonicalPage,
  openBrowserCanonicalSession, upsertBrowserIdentity, upsertBrowserMessage } from '@web/runtime/browserCanonicalProjection';

/** Applies only local projection operations; network delivery stays in the cloud clients. */
export function applyBrowserCanonicalCommand(state: CanonicalSessionState, command: string,
  args: Record<string, unknown> = {}, now = Date.now()): unknown {
  const request = args.request;
  switch (command) {
    case 'desktop_canonical_session_state': return state;
    case 'desktop_canonical_session_catalog': return browserCanonicalCatalog(state);
    case 'desktop_canonical_session_messages':
      return browserCanonicalPage(state, args as Parameters<typeof browserCanonicalPage>[1]);
    case 'desktop_canonical_upsert_identity':
    case 'desktop_canonical_upsert_identity_fast': {
      const identity = upsertBrowserIdentity(state, request as UpsertCanonicalIdentityRequest, now);
      return command.endsWith('_fast') ? identity : state;
    }
    case 'desktop_canonical_adopt_cloud_profile_identity':
      return adoptBrowserIdentity(state, request as AdoptCloudProfileIdentityRequest, now);
    case 'desktop_canonical_open_or_create_session':
    case 'desktop_canonical_open_or_create_session_fast': {
      const result = openBrowserCanonicalSession(state, request as OpenCanonicalSessionRequest, now);
      return command.endsWith('_fast') ? result : state;
    }
    case 'desktop_canonical_append_message':
    case 'desktop_canonical_append_message_fast':
    case 'desktop_canonical_upsert_message':
    case 'desktop_canonical_upsert_message_fast': {
      const message = upsertBrowserMessage(state, request as AppendCanonicalMessageRequest, now);
      return command.endsWith('_fast') ? message : state;
    }
    case 'desktop_canonical_update_message_delivery': {
      const input = request as UpdateCanonicalMessageDeliveryRequest;
      const row = state.messages.find(message => message.id === input.messageId && message.sessionId === input.sessionId);
      const session = state.sessions.find(item => item.id === input.sessionId);
      if (!row || !session) return null;
      row.status = input.status;
      row.updatedAtMs = now;
      row.content = { ...(typeof row.content === 'object' && row.content ? row.content : {}),
        deliveryState: input.deliveryState, deliveredRecipientIds: input.deliveredRecipientIds,
        pendingRecipientIds: input.pendingRecipientIds, exhaustedRecipientIds: input.exhaustedRecipientIds };
      session.updatedAtMs = now;
      return { ...input, updatedAtMs: now, contentHash: row.contentHash ?? '',
        sessionUpdatedAtMs: now, sessionLastMessageAtMs: session.lastMessageAtMs ?? null };
    }
    case 'desktop_canonical_rename_session': {
      const input = request as RenameCanonicalSessionRequest;
      const session = requireSession(state, input.sessionId);
      const title = input.title.trim();
      if (!title) throw new Error('Session title is required.');
      const previous = session.metadata && typeof session.metadata === 'object' ? session.metadata as Record<string, unknown> : {};
      const metadata: Record<string, unknown> = { ...previous, ...sessionTitleMetadata('manual', {
        revision: (Number.isSafeInteger(previous.sessionTitleRevision) ? Number(previous.sessionTitleRevision) : 0) + 1,
        updatedAtMs: now,
      }) };
      const actor = session.kind === 'group' ? state.identities.find(row => row.id === input.requestedByIdentityId)?.humanId : null;
      if (actor?.startsWith('acct_')) metadata.sessionTitleUpdatedByAccountId = actor;
      else delete metadata.sessionTitleUpdatedByAccountId;
      session.title = title;
      session.metadata = metadata;
      session.updatedAtMs = now;
      return state;
    }
    case 'desktop_canonical_update_session_metadata': {
      const input = request as UpdateCanonicalSessionMetadataRequest;
      const session = requireSession(state, input.sessionId);
      session.metadata = input.metadata;
      session.updatedAtMs = now;
      return state;
    }
    case 'desktop_canonical_add_session_participants': {
      const input = request as AddCanonicalSessionParticipantsRequest;
      const session = requireSession(state, input.sessionId);
      openBrowserCanonicalSession(state, { ...session, kind: session.kind as OpenCanonicalSessionRequest['kind'],
        participantIdentityIds: input.identityIds }, now);
      return state;
    }
    case 'desktop_canonical_add_group_members_fast': {
      const input = request as AddCanonicalGroupMembersRequest;
      const sessionIds = new Set(input.sessions.map(item => item.sessionId));
      const messages = [];
      for (const update of input.sessions) {
        const session = requireSession(state, update.sessionId);
        if (session.kind !== 'group') throw new Error('This conversation is not a group.');
        const metadata = { ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}) } as Record<string, unknown>;
        const groupSpaceId = metadata.groupSpaceId ?? metadata.groupId ?? update.groupSpaceId;
        metadata.groupId = groupSpaceId; metadata.groupSpaceId = groupSpaceId;
        for (const [key, additions] of [['initialContactIds', update.addedContactIds], ['initialParticipantNames', update.addedParticipantNames]] as const) {
          metadata[key] = [...new Set([...(Array.isArray(metadata[key]) ? metadata[key] as string[] : []), ...additions])];
        }
        openBrowserCanonicalSession(state, { ...session, kind: 'group', metadata, participantIdentityIds: input.identityIds }, now);
        const inviter = state.identities.find(row => row.id === input.addedByIdentityId)?.displayName ?? 'Someone';
        for (const event of input.joinEvents) {
          if (!input.identityIds.includes(event.memberIdentityId)) throw new Error('The invited member does not match the join event.');
          const name = state.identities.find(row => row.id === event.memberIdentityId)?.displayName ?? 'Someone';
          const id = `msg:group-member-join:${event.eventId}:${session.id}`;
          messages.push(upsertBrowserMessage(state, { id, sessionId: session.id, senderIdentityId: input.addedByIdentityId,
            senderRole: 'system', messageKind: 'status', status: 'complete', createdAtMs: event.createdAtMs,
            contentText: `${name} joined the group, invited by ${inviter}.`, sourceTransport: 'group-member-join', sourceEventId: id,
            content: { kind: 'group-member-joined', eventId: event.eventId, memberIdentityId: event.memberIdentityId,
              memberDisplayName: name, invitedByIdentityId: input.addedByIdentityId, invitedByDisplayName: inviter } }, now));
        }
      }
      return { sessions: state.sessions.filter(row => sessionIds.has(row.id)),
        participants: state.participants.filter(row => sessionIds.has(row.sessionId)), messages };
    }
    case 'desktop_canonical_remove_session_participant': {
      const input = request as RemoveCanonicalSessionParticipantRequest;
      const participant = state.participants.find(row => row.sessionId === input.sessionId && row.identityId === input.identityId);
      if (!participant) throw new Error('This participant is not loaded. Refresh the conversation.');
      participant.state = 'left';
      return state;
    }
    case 'desktop_canonical_set_session_participant_role': {
      const input = request as SetCanonicalSessionParticipantRoleRequest;
      const participant = state.participants.find(row => row.sessionId === input.sessionId && row.identityId === input.identityId);
      if (!participant) throw new Error('This participant is not loaded. Refresh the conversation.');
      participant.role = input.role;
      return state;
    }
    case 'desktop_canonical_mark_session_read': {
      const input = request as MarkCanonicalSessionReadRequest;
      const identityId = input.identityId ?? state.profile.humanIdentityId;
      const participant = state.participants.find(row => row.sessionId === input.sessionId && row.identityId === identityId);
      if (!participant || !identityId) return null;
      const messages = state.messages.filter(row => row.sessionId === input.sessionId).sort((a, b) => a.sequenceNum - b.sequenceNum);
      const message = input.messageId ? messages.find(row => row.id === input.messageId) : messages[messages.length - 1];
      if (input.messageId && !message) return null;
      participant.lastSeenAtMs = now;
      if (message && message.sequenceNum >= (participant.lastReadSequenceNum ?? 0)) {
        participant.lastReadMessageId = message.id;
        participant.lastReadSequenceNum = message.sequenceNum;
      }
      return { sessionId: input.sessionId, identityId, lastSeenAtMs: now,
        lastReadMessageId: participant.lastReadMessageId ?? null, lastReadSequenceNum: participant.lastReadSequenceNum ?? null };
    }
    case 'desktop_canonical_update_presence': {
      const input = request as UpdateCanonicalPresenceRequest;
      state.presence = [...state.presence.filter(row => row.identityId !== input.identityId), { ...input, updatedAtMs: now }];
      return state;
    }
    case 'desktop_canonical_create_delegated_exchange': {
      const input = request as CreateCanonicalDelegatedExchangeRequest;
      requireSession(state, input.sessionId);
      const id = input.id ?? crypto.randomUUID();
      const previous = state.delegatedExchanges.find(row => row.id === id);
      state.delegatedExchanges = [...state.delegatedExchanges.filter(row => row.id !== id),
        { ...previous, ...input, id, transport: input.transport ?? 'cloud', contextPolicy: input.contextPolicy ?? 'recent-window',
          status: input.status ?? 'pending', createdAtMs: previous?.createdAtMs ?? now, updatedAtMs: now }];
      return state;
    }
    case 'desktop_canonical_existing_message_sources': {
      const sources = args.sources as Array<{ sourceTransport: string; sourceEventId: string }>;
      return sources.filter(source => state.messages.some(row => row.sourceTransport === source.sourceTransport && row.sourceEventId === source.sourceEventId));
    }
    case 'desktop_canonical_delete_cloud_message': {
      const removed = state.messages.filter(row => browserCanonicalCloudMessageId(row) === args.cloudMessageId);
      state.messages = state.messages.filter(row => !removed.includes(row));
      return removed.map(row => row.id);
    }
    case 'desktop_canonical_reconcile_message_mirror': {
      const preferred = state.messages.find(row => row.id === args.preferredMessageId);
      const duplicate = state.messages.find(row => row.id === args.duplicateMessageId);
      if (!preferred || !duplicate || preferred.sessionId !== duplicate.sessionId || preferred.id === duplicate.id) return false;
      // Refuse to merge unrelated messages. The sync planner provides the matching request provenance.
      const left = preferred.content as { requestId?: string } | null;
      const right = duplicate.content as { requestId?: string } | null;
      if (!left?.requestId || left.requestId !== right?.requestId) return false;
      state.messages = state.messages.filter(row => row.id !== duplicate.id);
      return true;
    }
    default: throw new Error('This operation requires the Kordi desktop app.');
  }
}

function requireSession(state: CanonicalSessionState, sessionId: string) {
  const session = state.sessions.find(row => row.id === sessionId);
  if (!session) throw new Error('This conversation is not loaded. Refresh it and try again.');
  return session;
}
