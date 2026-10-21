// Profile operations for the Common ground store (`commonGroundVersion` 2):
// the list, the current profile, create, rename, delete, and switching the
// profile shared in a room. Servers without profiles never reach these.

import { isRouteMissing, type CommonGroundClient } from './client';
import { pickProfile, type CgProfileMemory } from './profiles';
import type { CgScreen, CgState } from './store';
import type { CgProfile, CgProfileInput } from './types';

/** The parts of the store these operations use. */
export type CgProfileStoreHost = {
  readonly client: CommonGroundClient;
  readonly memory: CgProfileMemory;
  getSnapshot: () => CgState;
  set: (patch: Partial<CgState>) => void;
  run: <T>(key: string, work: () => Promise<T>) => Promise<T | null>;
  open: (screen: CgScreen) => void;
  top: () => CgScreen;
  home: () => void;
  loadScreen: (screen?: CgScreen) => Promise<void>;
  loadRooms: () => Promise<void>;
};

/** Loads the profiles and settles the current one; an older server turns profiles off. */
export async function loadProfiles(host: CgProfileStoreHost): Promise<void> {
  if (!host.getSnapshot().profilesOn) return;
  try {
    const profiles = await host.client.profiles();
    const profileId = pickProfile(profiles, host.getSnapshot().profileId ?? host.memory.read());
    host.set({ profiles, profileId });
  } catch (error) {
    if (!isRouteMissing(error)) throw error;
    host.set({ profilesOn: false, profiles: [], profileId: null });
  }
}

export async function selectProfile(host: CgProfileStoreHost, profileId: string): Promise<void> {
  host.memory.write(profileId);
  host.set({ profileId, notice: null });
  const owner = await host.run('profile', () => host.client.card(profileId));
  if (owner && host.getSnapshot().profileId === profileId) host.set({ owner });
}

/** Creates a profile, makes it current and opens Build for it. */
export async function createProfile(host: CgProfileStoreHost, input: CgProfileInput): Promise<boolean> {
  const created = await host.run('profile', () => host.client.createProfile(input));
  if (!created) return false;
  host.set({ profiles: [...host.getSnapshot().profiles, created] });
  await selectProfile(host, created.profileId);
  host.open({ name: 'build' });
  return true;
}

export async function updateProfile(host: CgProfileStoreHost, profileId: string, patch: { name?: string; focus?: string }): Promise<boolean> {
  const updated = await host.run('profile', () => host.client.updateProfile(profileId, patch));
  if (!updated) return false;
  const { profiles, owner } = host.getSnapshot();
  host.set({ profiles: profiles.map((profile) => (profile.profileId === profileId ? { ...profile, ...updated } : profile)) });
  if (owner?.profile?.profileId === profileId) {
    host.set({ owner: { ...owner, profile: { profileId, kind: updated.kind, name: updated.name, focus: updated.focus } } });
  }
  return true;
}

/** Deletes a profile; the server leaves the rooms it was shared in. */
export async function deleteProfile(host: CgProfileStoreHost, profileId: string): Promise<boolean> {
  const deleted = await host.run('profile', async () => { await host.client.deleteProfile(profileId); return true; });
  if (!deleted) return false;
  const remaining: CgProfile[] = host.getSnapshot().profiles.filter((profile) => profile.profileId !== profileId);
  const saved = host.memory.read();
  const next = pickProfile(remaining, saved === profileId ? null : saved);
  host.memory.write(next);
  host.set({ profiles: remaining, profileId: next, rooms: {}, results: {}, matches: {}, people: {} });
  host.home();
  return true;
}

/** Shares another profile in an open room; its matches there run again. */
export async function switchRoomProfile(host: CgProfileStoreHost, code: string, profileId: string): Promise<boolean> {
  const room = await host.run('switch', () => host.client.switchRoomProfile(code, profileId));
  if (!room) return false;
  const { rooms, results } = host.getSnapshot();
  const { [code]: _stale, ...rest } = results;
  host.set({ rooms: { ...rooms, [code]: room }, results: rest });
  const top = host.top();
  if (top.name === 'results' && top.code === code) void host.loadScreen(top);
  void host.loadRooms();
  return true;
}
