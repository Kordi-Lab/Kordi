import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import React, { act, useCallback, useState, type MutableRefObject } from 'react';

import { setMessageLayout } from '../src/app/messageLayoutPreference';
import type { CloudAccount, CloudAuthClient, CloudPublicProfile } from '../src/features/cloud/authClient';
import { CANONICAL_AVATAR_RENDERER_VERSION } from '../src/features/cloud/canonicalAvatar';
import type { ChatSyncEvent } from '../src/features/cloud/chatSyncTypes';
import { publishCloudDeviceEvents } from '../src/features/cloud/cloudDeviceEvents';
import type { CanonicalSessionStateSetter, CloudGroupSessionPreparationCache } from '../src/features/cloud/cloudGroupControlContext';
import { CLOUD_GROUP_PROFILE_REFRESH_DELAY_MS, useCloudGroupProfileRefresh } from '../src/features/cloud/cloudGroupProfileRefresh';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalSessionState, UpsertCanonicalIdentityRequest } from '../src/kordi-app/types';
import {
  account,
  agentAvatar,
  agentReplyRow,
  ALEX,
  applyAgentReply,
  groupProfileCache,
  GROUP,
  member,
  PRIYA,
  profile,
} from './helpers/cloudGroupAgentReply';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const OTHER_GROUP = 'session:group:other';
const UNRELATED = 'acct_zoe';

function directoryChanged(accountId: string): ChatSyncEvent {
  return {
    stream_seq: 1, event_id: `directory:${accountId}`, protocol_version: 2, type: 'account.directory.changed',
    critical: true, conversation_id: null, entity_id: null, entity_version: null,
    occurred_at: '2026-10-25T00:00:00Z', payload: { accountId, agentAvatarVersion: 2 },
  };
}

type AlexWindowProps = {
  alex: CloudAccount;
  initialState: CanonicalSessionState;
  client: CloudAuthClient;
  stateRef: MutableRefObject<CanonicalSessionState | null>;
  profileCacheRef: MutableRefObject<Map<string, CloudPublicProfile>>;
  preparationCacheRef: MutableRefObject<{ entries: CloudGroupSessionPreparationCache }>;
  /** Remounts the row once native calls end, since avatars load differently inside Tauri. */
  tick: number;
};

/** Alex's open group: the hook as the app mounts it, and Priya's agent reply as the transcript draws it. */
function AlexWindow({ alex, initialState, client, stateRef, profileCacheRef, preparationCacheRef, tick }: AlexWindowProps) {
  const [state, setStateValue] = useState<CanonicalSessionState | null>(initialState);
  const setState = useCallback<CanonicalSessionStateSetter>((update) => {
    stateRef.current = update(stateRef.current);
    setStateValue(stateRef.current);
  }, [stateRef]);
  useCloudGroupProfileRefresh({ account: alex, client, profileCacheRef, preparationCacheRef, canonicalStateRef: stateRef, setState });
  return state ? <MessageBubble key={tick} msg={agentReplyRow(state, alex.accountId)} /> : null;
}

const waitForRefresh = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, CLOUD_GROUP_PROFILE_REFRESH_DELAY_MS + 50));
});

test("a collaborator's open group redraws the owner's agent on the next directory event, without a restart", async () => {
  const priya = account(PRIYA, 'Priya Tester', agentAvatar(PRIYA));
  const alex = account(ALEX, 'Alex Tester', agentAvatar(ALEX));
  const profileCacheRef = { current: groupProfileCache(alex, priya, alex) };
  const initialState = await applyAgentReply(alex, priya, alex, profileCacheRef.current);
  const stateRef = { current: initialState as CanonicalSessionState | null };
  const preparation = (participants: CloudAccount[]) => ({
    signature: 'fixture', localHumanIdentityId: `human:${ALEX}`, groupSpaceId: GROUP,
    participantByAccount: new Map(participants.map((owner) => [owner.accountId, member(owner, 'person')])),
    identityIdByAccount: new Map<string, string>(), agentAvatarByAccount: new Map(),
  });
  const preparationCacheRef = {
    current: { entries: new Map([[GROUP, preparation([priya, alex])], [OTHER_GROUP, preparation([alex])]]) },
  };
  const untouchedGroup = preparationCacheRef.current.entries.get(OTHER_GROUP);
  // Priya picks a bird in her window; the server now returns it on her public profile.
  let served = account(PRIYA, 'Priya Tester', agentAvatar(PRIYA, { style: 'kordi-birds', seed: 'bird-robin-color-coral', version: 2 }));
  const picked = served;
  const fetched: string[] = [];
  const client = {
    getProfile: async (_token: string, accountId: string) => {
      fetched.push(accountId);
      return profile(served, false);
    },
  } as unknown as CloudAuthClient;
  const upserts: UpsertCanonicalIdentityRequest[] = [];
  __setSessionBackendForTests({
    load: async () => ({ token: 'alex-token', accountId: ALEX, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  try {
    await withJsdomRoot(async (mount) => {
      // Native calls exist only while a refresh runs: with them mocked, avatars load through
      // the native proxy, which this test does not fake, so the picture is read once they end.
      const withNative = async (run: () => Promise<void>) => {
        mockIPC((command, payload) => {
          if (command !== 'desktop_canonical_upsert_identity_fast') throw new Error(`unexpected ${command}`);
          upserts.push(payload?.request as UpsertCanonicalIdentityRequest);
          return { ...(payload?.request as UpsertCanonicalIdentityRequest), createdAtMs: 1, updatedAtMs: 2 };
        });
        try {
          await run();
        } finally {
          clearMocks();
          // clearMocks keeps the internals object, which still reads as a Tauri runtime.
          Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
        }
      };
      // The events are built with the global constructor, so it must be the window's.
      const nodeCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
      Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
      try {
        await act(async () => { setMessageLayout('threads'); });
        const render = (tick: number) => mount(
          <AlexWindow alex={alex} initialState={initialState} client={client} stateRef={stateRef} profileCacheRef={profileCacheRef} preparationCacheRef={preparationCacheRef} tick={tick} />,
        );
        const host = await render(0);
        const src = () => host.querySelector('[data-avatar-kind="agent"] img')?.getAttribute('src') ?? '';
        assert.match(src(), new RegExp(`/v1/avatars/preview/kordi-birds/default-agent-${PRIYA}\\.png$`));

        // An account no open group loaded changes: nothing is fetched or redrawn.
        await act(async () => { publishCloudDeviceEvents([directoryChanged(UNRELATED)], ALEX, undefined); });
        await waitForRefresh();
        assert.deepEqual(fetched, []);
        assert.equal(upserts.length, 0);

        // A burst for Priya (plus Alex's own echo) is one fetch of Priya only.
        await withNative(async () => {
          await act(async () => {
            publishCloudDeviceEvents([directoryChanged(PRIYA), directoryChanged(ALEX)], ALEX, undefined);
            publishCloudDeviceEvents([directoryChanged(PRIYA)], ALEX, undefined);
          });
          await waitForRefresh();
        });
        await render(1);
        assert.deepEqual(fetched, [PRIYA]);
        assert.match(src(), new RegExp(`/v1/avatars/${CANONICAL_AVATAR_RENDERER_VERSION}/kordi-birds/bird-robin-color-coral\\.png\\?v=2$`));
        assert.equal(profileCacheRef.current.get(PRIYA)?.defaultAgent?.avatar.seed, 'bird-robin-color-coral');
        assert.deepEqual(upserts.map((request) => request.id), [`agent:cloud-agent:cloud-agent:${PRIYA}`], "Priya's own picture is unchanged");
        // The next agent reply in that group reuses the prepared data, now with the new bird.
        const group = preparationCacheRef.current.entries.get(GROUP);
        assert.equal(group?.agentAvatarByAccount.get(PRIYA)?.agentAvatarUrl, picked.defaultAgent?.avatarUrl);
        assert.equal(preparationCacheRef.current.entries.get(OTHER_GROUP), untouchedGroup);

        // The same profile again changes nothing.
        upserts.length = 0;
        const step = (run: () => void) => withNative(async () => {
          await act(async () => { run(); });
          await waitForRefresh();
        });
        await step(() => publishCloudDeviceEvents([directoryChanged(PRIYA)], ALEX, undefined));
        assert.deepEqual(fetched, [PRIYA, PRIYA]);
        assert.equal(upserts.length, 0);

        // Her own new photo redraws her rows the same way, and leaves her agent alone.
        served = { ...picked, avatar: { ...picked.avatar, seed: 'priya-new-photo', version: 2 } };
        await step(() => publishCloudDeviceEvents([directoryChanged(PRIYA)], ALEX, undefined));
        assert.deepEqual(upserts.map((request) => request.id), [`human:${PRIYA}`]);
        assert.match(upserts[0].profileImageUrl ?? '', /\/lorelei\/priya-new-photo\.png\?v=2$/);
      } finally {
        setMessageLayout('chat');
        if (nodeCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', nodeCustomEvent);
      }
    });
  } finally {
    __setSessionBackendForTests(null);
  }
});
