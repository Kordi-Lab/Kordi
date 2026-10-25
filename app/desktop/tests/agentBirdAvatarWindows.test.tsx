import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import React, { act } from 'react';

import { setMessageLayout } from '../src/app/messageLayoutPreference';
import { canonicalStateFromStore, createCanonicalStore, mergeCanonicalCatalog } from '../src/features/canonical/canonicalStore';
import { localAgentAvatarFromAccount, setLocalAgentAvatar } from '../src/features/canonical/localAgentAvatar';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CloudAccount, CloudPublicProfile } from '../src/features/cloud/authClient';
import { birdAvatarFromSeed } from '../src/features/cloud/birdAvatars';
import { CANONICAL_AVATAR_RENDERER_VERSION, canonicalAvatarImageSource, type CanonicalAvatarDescriptor } from '../src/features/cloud/canonicalAvatar';
import {
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
} from '../src/features/cloud/cloudAgentRequestState';
import { upsertCanonicalIdentityIntoLocalState } from '../src/features/cloud/cloudCanonicalStateMerge';
import { applyCloudGroupMessageControl } from '../src/features/cloud/cloudGroupMessageControl';
import type { CloudGroupControlEnvelope, CloudGroupParticipant } from '../src/features/cloud/cloudGroupMessages';
import { applyCloudGroupSessionControl } from '../src/features/cloud/cloudGroupSessionControl';
import { cleanCloudText, cloudObjectContent } from '../src/features/cloud/cloudValue';
import {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
} from '../src/features/cloud/useCloudGroupControlApplication';
import { EditableIdentityAvatar } from '../src/kordi-app/components/EditableIdentityAvatar';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  Message,
  UpsertCanonicalIdentityRequest,
} from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const RENDERER = CANONICAL_AVATAR_RENDERER_VERSION;
const GROUP = 'session:group:birds';
const PRIYA = 'acct_8eea4b7f6d474295b77c68a5a41d0755';
const ALEX = 'acct_alex';
const UPLOADED = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';

function agentAvatar(accountId: string, overrides: Partial<CanonicalAvatarDescriptor> = {}): CanonicalAvatarDescriptor {
  return {
    ...cloudAccountAvatarFixture,
    entityType: 'agent',
    entityId: `cloud-agent:${accountId}`,
    style: 'thumbs',
    seed: `default-agent-${accountId}`,
    ...overrides,
  };
}

function account(accountId: string, displayName: string, avatar: CanonicalAvatarDescriptor): CloudAccount {
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
function profile(owner: CloudAccount, isSelf: boolean): CloudPublicProfile {
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
function member(owner: CloudAccount, role: string): CloudGroupParticipant {
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

/** Runs one window's real group pipeline for Priya's agent reply and returns the transcript row it stores. */
async function agentReplyFor(viewer: CloudAccount, priya: CloudAccount, alex: CloudAccount): Promise<Message> {
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
    const envelope = envelopeFrom(priya, alex);
    const context = await applyCloudGroupSessionControl({
      cloudMessage: {
        messageId: 'wire:reply-1', fromAccountId: PRIYA, toAccountId: viewer.accountId, body: '',
        createdAt: '2026-10-25T00:00:00Z', deliveredAt: null, readAt: null,
        direction: viewer.accountId === PRIYA ? 'outgoing' : 'incoming',
        sessionId: GROUP, version: 1, conversationSequence: 5,
      },
      envelope,
      historyReplay: true,
      runtime: {
        account: viewer,
        client: {} as never,
        profileCache: new Map([
          [PRIYA, profile(priya, viewer.accountId === PRIYA)],
          [ALEX, profile(alex, viewer.accountId === ALEX)],
        ]),
        sessionPreparationCache: new Map(),
      },
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
  const row = state.messages.find((message) => message.senderIdentityId.startsWith('agent:'));
  assert.ok(row, 'the agent reply is stored');
  const message = mapCanonicalMessage(row, new Map(state.identities.map((identity) => [identity.id, identity])), `human:${viewer.accountId}`);
  assert.ok(message);
  return message;
}

/** The src each window's transcript draws for the same agent reply: Priya owns the agent, Alex does not. */
async function bothWindows(priyaAgentAvatar: CanonicalAvatarDescriptor) {
  const priya = account(PRIYA, 'Priya Tester', priyaAgentAvatar);
  const alex = account(ALEX, 'Alex Tester', agentAvatar(ALEX));
  const windows = [
    { name: 'owner' as const, viewer: priya, message: await agentReplyFor(priya, priya, alex) },
    { name: 'collaborator' as const, viewer: alex, message: await agentReplyFor(alex, priya, alex) },
  ];
  const sources: Record<'owner' | 'collaborator', string> = { owner: '', collaborator: '' };
  for (const { name, viewer, message } of windows) {
    await withJsdomRoot(async (mount) => {
      try {
        await act(async () => {
          setMessageLayout('threads');
          setLocalAgentAvatar(localAgentAvatarFromAccount(viewer));
        });
        const host = await mount(<MessageBubble msg={message} />);
        assert.match(host.textContent ?? '', name === 'owner' ? /Owner · You/ : /Owner · Priya Tester/);
        sources[name] = host.querySelector('[data-avatar-kind="agent"] img')?.getAttribute('src') ?? '';
      } finally {
        setMessageLayout('chat');
        setLocalAgentAvatar(null);
      }
    });
  }
  return sources;
}

test('an untouched agent shows the same seeded bird to its owner and to collaborators', async () => {
  const { owner, collaborator } = await bothWindows(agentAvatar(PRIYA));
  assert.match(owner, new RegExp(`/v1/avatars/preview/kordi-birds/default-agent-${PRIYA}\\.png$`));
  assert.equal(collaborator, owner);
});

test('a collaborator sees the bird the owner picked for their agent', async () => {
  const { owner, collaborator } = await bothWindows(agentAvatar(PRIYA, { style: 'kordi-birds', seed: 'bird-owl-ink-sky', version: 2 }));
  assert.match(owner, new RegExp(`/v1/avatars/${RENDERER}/kordi-birds/bird-owl-ink-sky\\.png\\?v=2$`));
  assert.equal(collaborator, owner);
});

test('a collaborator sees the photo the owner uploaded for their agent', async () => {
  const { owner, collaborator } = await bothWindows(agentAvatar(PRIYA, { source: 'uploaded', uploadedAsset: UPLOADED, version: 3 }));
  assert.match(owner, /\/v1\/avatars\/assets\/ava_0123456789abcdef0123456789abcdef\/256\.jpg$/);
  assert.equal(collaborator, owner);
});

test('the avatar picker opens on the bird an untouched agent already shows, and still saves', async () => {
  const seed = `default-agent-${PRIYA}`;
  const shown = birdAvatarFromSeed(seed);
  const picks: string[] = [];
  await withJsdomRoot(async (mount) => {
    try {
      await act(async () => {
        setLocalAgentAvatar(localAgentAvatarFromAccount(account(PRIYA, 'Priya Tester', agentAvatar(PRIYA))));
      });
      const host = await mount(<EditableIdentityAvatar kind="agent" seed={seed} name="Priya Tester's Kordi" onPick={(next) => { picks.push(next); }} />);
      assert.match(host.querySelector('img')?.getAttribute('src') ?? '', new RegExp(`preview/kordi-birds/${seed}\\.png$`));
      await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Choose avatar"]')!.click(); });
      const dialog = document.querySelector('[role="dialog"][aria-label="Avatar"]');
      assert.ok(dialog);
      assert.equal(dialog.querySelector(`[data-bird-species="${shown.species}"]`)?.getAttribute('aria-pressed'), 'true');
      assert.equal(dialog.querySelector(`[data-bird-palette="${shown.palette}"]`)?.getAttribute('aria-checked'), 'true');
      const buttons = () => Array.from(dialog.querySelectorAll('button'));
      assert.equal(buttons().find((button) => button.textContent === 'Color')?.getAttribute('aria-checked'), 'true');
      const save = () => buttons().find((button) => button.textContent === 'Save')!;
      assert.equal(save().disabled, true, 'nothing to save until the bird changes');

      const other = shown.species === 'owl' ? 'heron' : 'owl';
      await act(async () => { dialog.querySelector<HTMLButtonElement>(`[data-bird-species="${other}"]`)!.click(); });
      await act(async () => {
        save().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(picks, [`bird-${other}-color-${shown.palette}`]);
    } finally {
      setLocalAgentAvatar(null);
    }
  });
});
