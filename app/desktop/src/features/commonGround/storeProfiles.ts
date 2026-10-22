// Profile operations for the Common ground store (`commonGroundVersion` 2):
// the list, the current profile, create, rename, delete, and switching the
// profile shared in a room. Servers without profiles never reach these.

import { isRouteMissing, type CommonGroundClient } from './client';
import { pickProfile, type CgProfileMemory } from './profiles';
import type { CgScreen, CgState } from './store';
import type { CgCardLook, CgProfile, CgProfileInput, CgProfilePatch } from './types';

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

/**
 * Sets a card's background or icon at once and saves it; a failed save puts the old look back, and a
 * reply without the new value shows the server's look with a notice.
 */
export async function setLook(host: CgProfileStoreHost, profileId: string, look: Partial<CgCardLook>): Promise<boolean> {
  const before = host.getSnapshot().profiles.find((profile) => profile.profileId === profileId);
  if (!before) return false;
  const patchLook = (next: Partial<CgCardLook>) => host.set({
    profiles: host.getSnapshot().profiles.map((profile) => (profile.profileId === profileId ? { ...profile, ...next } : profile)),
  });
  patchLook(look);
  const updated = await host.run('look', () => host.client.updateProfile(profileId, look));
  if (!updated) {
    patchLook(Object.fromEntries(Object.keys(look).map((key) => [key, before[key as keyof CgCardLook]])));
    return false;
  }
  // The server's look is what every device shows; a reply without the new value did not save it.
  patchLook({ design: updated.design, icon: updated.icon });
  const saved = (Object.keys(look) as Array<keyof CgCardLook>).every((key) => updated[key] === look[key]);
  if (!saved) host.set({ notice: LOOK_NOT_SAVED });
  return saved;
}

export const LOOK_NOT_SAVED = 'Could not save the card look. Try again.';

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

export async function updateProfile(host: CgProfileStoreHost, profileId: string, patch: CgProfilePatch): Promise<boolean> {
  const updated = await host.run('profile', () => host.client.updateProfile(profileId, patch));
  if (!updated) return false;
  const { profiles, owner } = host.getSnapshot();
  host.set({ profiles: profiles.map((profile) => (profile.profileId === profileId ? { ...profile, ...updated } : profile)) });
  if (owner?.profile?.profileId === profileId) {
    const { kind, name, focus, design, icon } = updated;
    host.set({ owner: { ...owner, profile: { profileId, kind, name, focus, design, icon } } });
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
