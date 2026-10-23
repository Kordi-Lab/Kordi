// The Memories section of a card page (`memoryVersion` 2): the owner's memories filed to the open
// profile, with Move to… and Remove. Each change reloads the list and the card, so the
// "N new memories" line follows it.

import { useEffect, useState } from 'react';

import type { CommonGroundStore } from './store';
import type { CgProfile, CgRoutedMemory } from './types';

export type CgMoveTarget = { profileId: string | null; label: string };

/**
 * Where a memory can go: the owner's other profiles, which pin it there. A pinned memory also gets
 * No profile, which clears the pin so its category files it again. A memory every profile lists can
 * be pinned to any one profile, this one included.
 */
export function moveTargets(memory: CgRoutedMemory, profiles: CgProfile[], profileId: string): CgMoveTarget[] {
  const named = profiles
    .filter((profile) => memory.everyProfile || profile.profileId !== profileId)
    .map((profile) => ({ profileId: profile.profileId, label: profile.name }));
  return !memory.everyProfile && memory.profileId ? [...named, { profileId: null, label: 'No profile' }] : named;
}

export type CgMemoryHost = Pick<CommonGroundStore, 'client' | 'getSnapshot' | 'set' | 'run'>;

async function refreshOwner(host: CgMemoryHost, profileId: string) {
  const owner = await host.client.card(profileId).catch(() => null);
  if (owner && host.getSnapshot().profileId === profileId) host.set({ owner });
}

/** Files a memory to `target`, or back to its category with null. */
export async function moveMemory(host: CgMemoryHost, profileId: string, memoryId: string, target: string | null): Promise<boolean> {
  const moved = await host.run('memory', async () => { await host.client.moveMemory(memoryId, target); return true; });
  if (moved) await refreshOwner(host, profileId);
  return Boolean(moved);
}

/** Archives a memory; no card or agent reads it again. */
export async function removeMemory(host: CgMemoryHost, profileId: string, memoryId: string): Promise<boolean> {
  const removed = await host.run('memory', async () => { await host.client.removeMemory(memoryId); return true; });
  if (removed) await refreshOwner(host, profileId);
  return Boolean(removed);
}

export type ProfileMemories = {
  memories: CgRoutedMemory[];
  move: (memoryId: string, target: string | null) => Promise<boolean>;
  remove: (memoryId: string) => Promise<boolean>;
};

/** The open profile's memories; empty while they load, when routing is off, or when the route is missing. */
export function useProfileMemories(host: CgMemoryHost, profileId: string | null, enabled: boolean): ProfileMemories {
  const [loaded, setLoaded] = useState<{ profileId: string; memories: CgRoutedMemory[] } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || !profileId) return undefined;
    let active = true;
    host.client.profileMemories(profileId).then(
      (memories) => { if (active) setLoaded({ profileId, memories }); },
      () => { if (active) setLoaded({ profileId, memories: [] }); },
    );
    return () => { active = false; };
  }, [host, profileId, enabled, revision]);
  const reload = (done: boolean) => {
    if (done) setRevision((count) => count + 1);
    return done;
  };
  return {
    memories: enabled && profileId && loaded?.profileId === profileId ? loaded.memories : [],
    move: (memoryId, target) => (profileId ? moveMemory(host, profileId, memoryId, target).then(reload) : Promise.resolve(false)),
    remove: (memoryId) => (profileId ? removeMemory(host, profileId, memoryId).then(reload) : Promise.resolve(false)),
  };
}

/** "3 new memories since this card was built"; null when there are none. */
export function newMemoriesLine(count: number | null | undefined): string | null {
  if (!count || count < 1) return null;
  return `${count} new ${count === 1 ? 'memory' : 'memories'} since this card was built`;
}
