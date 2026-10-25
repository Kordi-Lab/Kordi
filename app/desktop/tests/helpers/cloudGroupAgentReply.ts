import assert from 'node:assert/strict';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import { canonicalStateFromStore, createCanonicalStore, mergeCanonicalCatalog } from '../../src/features/canonical/canonicalStore';
import { mapCanonicalMessage } from '../../src/features/canonical/readModel/messageMapping';
import type { CloudAccount, CloudPublicProfile } from '../../src/features/cloud/authClient';
import { canonicalAvatarImageSource, type CanonicalAvatarDescriptor } from '../../src/features/cloud/canonicalAvatar';
import {
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
} from '../../src/features/cloud/cloudAgentRequestState';
import { upsertCanonicalIdentityIntoLocalState } from '../../src/features/cloud/cloudCanonicalStateMerge';
import { applyCloudGroupMessageControl } from '../../src/features/cloud/cloudGroupMessageControl';
import type { CloudGroupControlEnvelope, CloudGroupParticipant } from '../../src/features/cloud/cloudGroupMessages';
import { applyCloudGroupSessionControl } from '../../src/features/cloud/cloudGroupSessionControl';
import { cleanCloudText, cloudObjectContent } from '../../src/features/cloud/cloudValue';
import {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
} from '../../src/features/cloud/useCloudGroupControlApplication';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  Message,
  UpsertCanonicalIdentityRequest,
} from '../../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './cloudAccountAvatarFixture';

export const GROUP = 'session:group:birds';
export const PRIYA = 'acct_8eea4b7f6d474295b77c68a5a41d0755';
export const ALEX = 'acct_alex';

export function agentAvatar(accountId: string, overrides: Partial<CanonicalAvatarDescriptor> = {}): CanonicalAvatarDescriptor {
  return {
    ...cloudAccountAvatarFixture,
    entityType: 'agent',
    entityId: `cloud-agent:${accountId}`,
    style: 'thumbs',
    seed: `default-agent-${accountId}`,
    ...overrides,
  };
}

export function account(accountId: string, displayName: string, avatar: CanonicalAvatarDescriptor): CloudAccount {
  return {
    accountId,
    displayName,
    primaryEmail: `${accountId}@example.test`,
    avatarUrl: null,
    avatar: { ...cloudAccountAvatarFixture, entityId: accountId, seed: accountId },
    defaultAgent: {
      agentId: `cloud-agent:${accountId}`,
      displayName: `${displayName}'s Kordi`,
      avatarUrl: canonicalAvatarImageSource(avatar),
      avatar,
    },
    nodeId: null,
    passwordSet: true,
  };
}

/** The public profile another member loads; the viewer's own entry carries no agent, as the app builds it. */
export function profile(owner: CloudAccount, isSelf: boolean): CloudPublicProfile {
  return {
    accountId: owner.accountId,
    displayName: owner.displayName,
    avatarUrl: canonicalAvatarImageSource(owner.avatar),
    ...(isSelf ? {} : { defaultAgent: owner.defaultAgent }),
    nodeId: null,
    isContact: false,
    isSelf,
  };
}

// Desktop-sent envelopes carry no agent pictures, so the collaborator must get it elsewhere.
export function member(owner: CloudAccount, role: string): CloudGroupParticipant {
  return { accountId: owner.accountId, displayName: owner.displayName ?? owner.accountId, avatarUrl: null, role };
}

function envelopeFrom(priya: CloudAccount, alex: CloudAccount): CloudGroupControlEnvelope {
  return {
    kind: 'group-message',
    groupId: GROUP,
    groupTitle: 'Birds',
    createdByAccountId: PRIYA,
    actor: member(priya, 'admin'),
    participants: [member(priya, 'admin'), member(alex, 'person')],
    message: {
      id: 'msg:cloud-agent:reply-1', text: 'Hello from my agent', senderAccountId: PRIYA,
      senderAgentId: `cloud-agent:${PRIYA}`, senderKind: 'agent', senderDisplayName: "Priya Tester's Kordi",
      deliveryState: 'complete', createdAtMs: 10,
    },
  } as CloudGroupControlEnvelope;
}

function initialState(viewer: string): CanonicalSessionState {
  const state = canonicalStateFromStore(mergeCanonicalCatalog(createCanonicalStore(), {
    storagePath: '/tmp/agent-bird.sqlite',
    profile: { id: 'fixture', humanIdentityId: `human:${viewer}`, storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [], participants: [], delegatedExchanges: [], presence: [], summaries: [],
    sessions: [{ id: GROUP, kind: 'group', title: 'Birds', status: 'active', createdByIdentityId: `human:${PRIYA}`, createdAtMs: 1, updatedAtMs: 1 }],
  }))!;
  return { ...state, messages: [] };
}

const unexpected = () => { throw new Error('history replay never resolves admins or titles'); };

/** The profiles a window has loaded for Priya and Alex. */
export function groupProfileCache(viewer: CloudAccount, priya: CloudAccount, alex: CloudAccount) {
  return new Map([
    [PRIYA, profile(priya, viewer.accountId === PRIYA)],
    [ALEX, profile(alex, viewer.accountId === ALEX)],
  ]);
}

/** Runs one window's real group pipeline for Priya's agent reply and returns the canonical state it stores. */
export async function applyAgentReply(
  viewer: CloudAccount,
  priya: CloudAccount,
  alex: CloudAccount,
  profileCache = groupProfileCache(viewer, priya, alex),
): Promise<CanonicalSessionState> {
  let current: CanonicalSessionState | null = initialState(viewer.accountId);
  let sequence = 10;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  mockIPC((command, payload) => {
    if (command === 'desktop_canonical_upsert_identity_fast') {
      return { ...(payload?.request as UpsertCanonicalIdentityRequest), createdAtMs: 1, updatedAtMs: 1 };
    }
    assert.equal(command, 'desktop_canonical_upsert_message_fast');
    sequence += 1;
    return { ...(payload?.request as AppendCanonicalMessageRequest), sequenceNum: sequence, updatedAtMs: sequence, contentHash: null };
  });
  try {
    const context = await applyCloudGroupSessionControl({
      cloudMessage: {
        messageId: 'wire:reply-1', fromAccountId: PRIYA, toAccountId: viewer.accountId, body: '',
        createdAt: '2026-10-25T00:00:00Z', deliveredAt: null, readAt: null,
        direction: viewer.accountId === PRIYA ? 'outgoing' : 'incoming',
        sessionId: GROUP, version: 1, conversationSequence: 5,
      },
      envelope: envelopeFrom(priya, alex),
      historyReplay: true,
      runtime: { account: viewer, client: {} as never, profileCache, sessionPreparationCache: new Map() },
      canonical: { getState: () => current, setState: (update) => { current = update(current); } },
      stateOps: {
        objectContent: cloudObjectContent,
        cleanText: cleanCloudText,
        resolveAdminSnapshot: unexpected,
        resolveSessionTitle: unexpected,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        mergeOpenSession: unexpected,
      },
    });
    assert.ok(context);
    await applyCloudGroupMessageControl({
      context,
      setCanonicalState: (update) => { current = update(current); },
      stateOps: {
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
      },
    });
  } finally {
    clearMocks();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  const state = current as CanonicalSessionState | null;
  assert.ok(state);
  return state;
}

/** The transcript row a window draws for Priya's agent reply, read through the identities as the app renders it. */
export function agentReplyRow(state: CanonicalSessionState, viewerAccountId: string): Message {
  const row = state.messages.find((message) => message.senderIdentityId.startsWith('agent:'));
  assert.ok(row, 'the agent reply is stored');
  const message = mapCanonicalMessage(row, new Map(state.identities.map((identity) => [identity.id, identity])), `human:${viewerAccountId}`);
  assert.ok(message);
  return message;
}
