import type { AppendCanonicalMessageRequest, CanonicalSessionMessage, CanonicalSessionState, Message } from '../../src/kordi-app/types';
import { mapCanonicalMessage } from '../../src/features/canonical/readModel/messageMapping';
import { applyCloudGroupMessageControl } from '../../src/features/cloud/cloudGroupMessageControl';
import type { CloudGroupControlContext } from '../../src/features/cloud/cloudGroupControlContext';
import {
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
} from '../../src/features/cloud/cloudAgentRequestState';
import { upsertCanonicalIdentityIntoLocalState } from '../../src/features/cloud/cloudCanonicalStateMerge';
import {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
} from '../../src/features/cloud/useCloudGroupControlApplication';
import { cleanCloudText, cloudObjectContent } from '../../src/features/cloud/cloudValue';

// Runs the app's real group-message ingestion and canonical mapping for one
// agent reply and its background follow-up, the way group replay re-applies
// the same wire rows after a group opens.
const GROUP = 'synthetic-group';
const ME = 'synthetic-account';
export type ReplayWire = { id: string; requestId: string; text: string; createdAtMs: number; tools: boolean; sequence: number };

const stateOps = {
  objectContent: cloudObjectContent,
  cleanText: cleanCloudText,
  upsertIdentity: upsertCanonicalIdentityIntoLocalState,
  processingSlot: cloudGroupAgentProcessingSlotForResponse,
  incomingAlreadyApplied: cloudGroupIncomingMessageAlreadyApplied,
  removeOfflinePlaceholder: removeCloudGroupOfflinePlaceholder,
  removeTimeoutPlaceholder: removeCloudGroupTimeoutPlaceholderForTerminalResponse,
  removePendingRows: removeCloudGroupPendingRowsForTerminalResponse,
  removeMessage: removeCanonicalMessageById,
  isProcessingPlaceholder: isCloudAgentProcessingPlaceholderText,
};

export function emptyReplayState(requestId: string, requestAtMs: number): CanonicalSessionState {
  return {
    storagePath: '/tmp/synthetic.sqlite',
    profile: { id: 'synthetic', humanIdentityId: 'human:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [{ id: 'human:me', kind: 'human', displayName: 'You', createdAtMs: 1, updatedAtMs: 1 }],
    participants: [], delegatedExchanges: [], presence: [],
    sessions: [{ id: GROUP, kind: 'group', title: 'Synthetic group', status: 'active', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 }],
    messages: [{
      id: requestId, sessionId: GROUP, sequenceNum: 1, senderIdentityId: 'human:me', senderRole: 'user',
      messageKind: 'text', contentText: 'Synthetic request', content: {}, status: 'sent', createdAtMs: requestAtMs, updatedAtMs: requestAtMs,
    }],
  } as unknown as CanonicalSessionState;
}

function context(state: CanonicalSessionState, requestId: string, wire: ReplayWire): CloudGroupControlContext {
  const owner = { accountId: ME, displayName: 'You', avatarUrl: null, role: 'person' as const };
  return {
    account: { accountId: ME } as CloudGroupControlContext['account'],
    cloudMessage: {
      messageId: `wire:${wire.id}`, fromAccountId: ME, toAccountId: ME, body: '',
      createdAt: new Date(wire.createdAtMs).toISOString(), deliveredAt: null, readAt: null,
      direction: 'outgoing', sessionId: GROUP, version: 1, conversationSequence: wire.sequence,
    },
    envelope: {
      kind: 'group-message', groupId: GROUP, groupTitle: 'Synthetic group', createdByAccountId: ME,
      actor: owner, participants: [owner],
      message: {
        id: wire.id, senderAccountId: ME, senderAgentId: 'synthetic-agent', senderKind: 'agent',
        senderDisplayName: 'Synthetic Agent', text: wire.text, createdAtMs: wire.createdAtMs,
        deliveryState: 'complete', replyToMessageId: requestId, requestId: wire.requestId,
        structuredContent: wire.tools ? { tools: [{
          id: 'synthetic-spawn', name: 'task_operator', status: 'completed',
          arguments: JSON.stringify({ action: 'spawn', taskTitle: 'Synthetic background task 13' }), liveOutput: '', isError: false,
        }, {
          id: 'background-session:synthetic-background-13', name: 'task_operator', status: 'completed',
          arguments: JSON.stringify({ action: 'spawn', taskTitle: 'Synthetic background task 13' }), liveOutput: '',
          resultText: `Background session: ${JSON.stringify({ sessionId: 'synthetic-background-13', title: 'Synthetic background task 13', status: 'failed' })}`,
          isError: false,
        }] } : null,
      },
    },
    canonicalState: state, nextState: state, localHumanIdentityId: 'human:me', groupSpaceId: GROUP,
    participantByAccount: new Map([[ME, owner]]), identityIdByAccount: new Map([[ME, 'human:me']]),
  } as CloudGroupControlContext;
}

// The native upsert keeps the owner's private tool trace when a later write of
// the same reply carries only public task links (group_reasoning.rs).
const publicTool = (tool: unknown) => {
  const record = cloudObjectContent(tool);
  return record.name === 'task_operator' && String(record.id ?? '').startsWith('background-session:');
};
export function nativeUpsert(existing: CanonicalSessionMessage | undefined, request: AppendCanonicalMessageRequest) {
  const previousTools = cloudObjectContent(existing?.content).tools;
  const incoming = cloudObjectContent(request.content);
  const sameRequest = existing && existing.messageKind === 'agent-turn' && existing.parentMessageId
    && existing.parentMessageId === request.parentMessageId && existing.senderIdentityId === request.senderIdentityId;
  const keepTools = sameRequest && Array.isArray(previousTools) && previousTools.some((tool) => !publicTool(tool))
    && (!Array.isArray(incoming.tools) || incoming.tools.every(publicTool));
  return keepTools ? { ...request, content: { ...incoming, tools: previousTools } } : request;
}

let sequence = 1000;
/** Applies wire rows in order with an in-memory stand-in for the native store. */
export async function ingestReplayWires(start: CanonicalSessionState, requestId: string, wires: ReplayWire[]) {
  let state = start;
  const host = window as unknown as { __TAURI_INTERNALS__?: unknown };
  host.__TAURI_INTERNALS__ = {
    invoke: async (command: string, payload: { request: AppendCanonicalMessageRequest & { id: string } }) => {
      if (command === 'desktop_canonical_upsert_identity_fast') return { ...payload.request, createdAtMs: 1, updatedAtMs: 1 };
      if (command !== 'desktop_canonical_upsert_message_fast') throw new Error(`Unavailable in this page: ${command}`);
      const existing = state.messages.find((row) => row.id === payload.request.id);
      sequence += 1;
      return { ...nativeUpsert(existing, payload.request), sequenceNum: existing?.sequenceNum ?? sequence, createdAtMs: payload.request.createdAtMs ?? 1, updatedAtMs: sequence };
    },
    transformCallback: () => 0,
  };
  try {
    for (const wire of wires) {
      const result = await applyCloudGroupMessageControl({
        context: context(state, requestId, wire),
        setCanonicalState: (update) => { state = update(state) ?? state; },
        stateOps,
      });
      if (result) state = result.nextState;
    }
  } finally {
    delete host.__TAURI_INTERNALS__;
  }
  return state;
}

/** The agent replies to the request, mapped exactly as the transcript receives them. */
export function replayedAgentMessages(state: CanonicalSessionState): Message[] {
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  return state.messages
    .filter((row) => row.senderRole !== 'user')
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .flatMap((row) => mapCanonicalMessage(row, identityById, 'human:me') ?? []);
}
