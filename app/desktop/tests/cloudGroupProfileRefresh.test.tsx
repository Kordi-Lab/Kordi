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
import {
  CLOUD_GROUP_PROFILE_REFRESH_DELAY_MS,
  createCloudGroupProfileRefreshGate,
  refreshCloudGroupProfiles,
  useCloudGroupProfileRefresh,
} from '../src/features/cloud/cloudGroupProfileRefresh';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const PRIYA_AGENT_IDENTITY = `agent:cloud-agent:cloud-agent:${PRIYA}`;

/** Priya's public profile with her agent on `seed`, as the server would serve it. */
function priyaProfile(seed: string, version: number) {
  const style = seed.startsWith('bird-') ? 'kordi-birds' as const : 'thumbs' as const;
  return profile(account(PRIYA, 'Priya Tester', agentAvatar(PRIYA, { style, seed, version })), false);
}

/** Alex's window after Priya's agent replied in their group: state, caches and the setter. */
async function alexWindowState() {
  const priya = account(PRIYA, 'Priya Tester', agentAvatar(PRIYA));
  const alex = account(ALEX, 'Alex Tester', agentAvatar(ALEX));
  const profileCache = groupProfileCache(alex, priya, alex);
  const stateRef = { current: await applyAgentReply(alex, priya, alex, profileCache) as CanonicalSessionState | null };
  const preparationCache: CloudGroupSessionPreparationCache = new Map([[GROUP, {
    signature: 'fixture', localHumanIdentityId: `human:${ALEX}`, groupSpaceId: GROUP,
    participantByAccount: new Map([priya, alex].map((owner) => [owner.accountId, member(owner, 'person')])),
    identityIdByAccount: new Map<string, string>(), agentAvatarByAccount: new Map(),
  }]]);
  const setState: CanonicalSessionStateSetter = (update) => { stateRef.current = update(stateRef.current); };
  const agentImage = () => stateRef.current?.identities.find((identity) => identity.id === PRIYA_AGENT_IDENTITY)?.profileImageUrl ?? '';
  return { alex, profileCache, preparationCache, stateRef, setState, agentImage };
}

/**
 * Runs with native identity writes recorded. A write whose picture matches `hold` waits for
 * the returned release, so a test can act while it is in flight.
 */
async function withNativeWrites(run: (writes: UpsertCanonicalIdentityRequest[], release: () => void) => Promise<void>, hold?: RegExp) {
  const writes: UpsertCanonicalIdentityRequest[] = [];
  const held = deferred<void>();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
  mockIPC(async (command, payload) => {
    assert.equal(command, 'desktop_canonical_upsert_identity_fast');
    const request = payload?.request as UpsertCanonicalIdentityRequest;
    writes.push(request);
    if (hold?.test(request.profileImageUrl ?? '')) await held.promise;
    return { ...request, createdAtMs: 1, updatedAtMs: 2 };
  });
  try {
    await run(writes, () => held.resolve());
  } finally {
    clearMocks();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('an older profile response that arrives after a newer one is dropped', async () => {
  const fixture = await alexWindowState();
  const gate = createCloudGroupProfileRefreshGate();
  const older = deferred<CloudPublicProfile>();
  const newer = deferred<CloudPublicProfile>();
  const responses = [older.promise, newer.promise];
  const client = { getProfile: async () => responses.shift()! };
  const refresh = () => refreshCloudGroupProfiles({
    accountIds: [PRIYA], token: 'alex-token', account: fixture.alex, client,
    profileCache: fixture.profileCache, preparationCache: fixture.preparationCache,
    getState: () => fixture.stateRef.current, setState: fixture.setState, gate,
  });
  await withNativeWrites(async (writes) => {
    const first = refresh();
    const second = refresh();
    newer.resolve(priyaProfile('bird-owl-ink-paper', 3));
    assert.deepEqual(await second, [PRIYA]);
    older.resolve(priyaProfile('bird-robin-color-coral', 2));
    assert.deepEqual(await first, [], 'the older response writes nothing');

    assert.deepEqual(writes.map((request) => request.id), [PRIYA_AGENT_IDENTITY]);
    assert.match(fixture.agentImage(), /\/kordi-birds\/bird-owl-ink-paper\.png\?v=3$/);
    assert.equal(fixture.profileCache.get(PRIYA)?.defaultAgent?.avatar.seed, 'bird-owl-ink-paper');
    assert.match(fixture.preparationCache.get(GROUP)?.agentAvatarByAccount.get(PRIYA)?.agentAvatarUrl ?? '', /bird-owl-ink-paper/);
  });
});

test('a newer profile response applies after an older write in flight, and against it', async () => {
  const fixture = await alexWindowState();
  const original = fixture.agentImage();
  assert.match(original, new RegExp(`/kordi-birds/default-agent-${PRIYA}\\.png$`));
  const gate = createCloudGroupProfileRefreshGate();
  const newer = deferred<CloudPublicProfile>();
  const responses = [Promise.resolve(priyaProfile('bird-robin-color-coral', 2)), newer.promise];
  const client = { getProfile: async () => responses.shift()! };
  const refresh = () => refreshCloudGroupProfiles({
    accountIds: [PRIYA], token: 'alex-token', account: fixture.alex, client,
    profileCache: fixture.profileCache, preparationCache: fixture.preparationCache,
    getState: () => fixture.stateRef.current, setState: fixture.setState, gate,
  });
  await withNativeWrites(async (writes, release) => {
    const first = refresh();
    while (writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // Priya changed back before the robin write finished; the newer fetch serves her default.
    const second = refresh();
    newer.resolve(priyaProfile(`default-agent-${PRIYA}`, 3));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(writes.length, 1, 'the newer response waits for the write in flight');
    release();
    await Promise.all([first, second]);

    assert.deepEqual(writes.map((request) => request.profileImageUrl?.match(/bird-robin|default-agent/u)?.[0]), ['bird-robin', 'default-agent']);
    assert.match(fixture.agentImage(), new RegExp(`/kordi-birds/default-agent-${PRIYA}\\.png$`));
    assert.equal(fixture.profileCache.get(PRIYA)?.defaultAgent?.avatar.version, 3);
  }, /bird-robin/u);
});

test('signing out mid-fetch or mid-write writes nothing more', async () => {
  // Mid-write: the store keeps the write in flight, but local state and later writes stop.
  const fixture = await alexWindowState();
  const before = fixture.stateRef.current;
  const gate = createCloudGroupProfileRefreshGate();
  await withNativeWrites(async (writes, release) => {
    const refresh = refreshCloudGroupProfiles({
      accountIds: [PRIYA], token: 'alex-token', account: fixture.alex,
      client: { getProfile: async () => priyaProfile('bird-robin-color-coral', 2) },
      profileCache: fixture.profileCache, preparationCache: fixture.preparationCache,
      getState: () => fixture.stateRef.current, setState: fixture.setState, gate,
    });
    while (writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    gate.close();
    release();
    assert.deepEqual(await refresh, []);
    assert.equal(fixture.stateRef.current, before, 'no state write after sign-out');
  }, /bird-robin/u);

  // Mid-fetch, through the listener as the app mounts it: signing out closes it.
  const window2 = await alexWindowState();
  const cachedProfile = window2.profileCache.get(PRIYA);
  const preparation = window2.preparationCache.get(GROUP);
  const stateBefore = window2.stateRef.current;
  const response = deferred<CloudPublicProfile>();
  let fetches = 0;
  const client = { getProfile: () => { fetches += 1; return response.promise; } } as unknown as CloudAuthClient;
  const profileCacheRef = { current: window2.profileCache };
  const preparationCacheRef = { current: { entries: window2.preparationCache } };
  function Listener({ signedIn }: { signedIn: CloudAccount | null }) {
    const setState = useCallback<CanonicalSessionStateSetter>((update) => { window2.stateRef.current = update(window2.stateRef.current); }, []);
    useCloudGroupProfileRefresh({ account: signedIn, client, profileCacheRef, preparationCacheRef, canonicalStateRef: window2.stateRef, setState });
    return null;
  }
  __setSessionBackendForTests({
    load: async () => ({ token: 'alex-token', accountId: ALEX, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  try {
    await withJsdomRoot(async (mount) => {
      const nodeCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
      Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
      const upserts: unknown[] = [];
      mockIPC((command) => { upserts.push(command); throw new Error(`unexpected ${command}`); });
      try {
        await mount(<Listener signedIn={window2.alex} />);
        await act(async () => { publishCloudDeviceEvents([directoryChanged(PRIYA)], ALEX, undefined); });
        await waitForRefresh();
        assert.equal(fetches, 1, 'the fetch is in flight');
        await mount(<Listener signedIn={null} />);
        await act(async () => {
          response.resolve(priyaProfile('bird-robin-color-coral', 2));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        assert.equal(window2.profileCache.get(PRIYA), cachedProfile);
        assert.equal(window2.preparationCache.get(GROUP), preparation);
        assert.equal(window2.stateRef.current, stateBefore);
        assert.deepEqual(upserts, []);
      } finally {
        clearMocks();
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
        if (nodeCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', nodeCustomEvent);
      }
    });
  } finally {
    __setSessionBackendForTests(null);
  }
});
