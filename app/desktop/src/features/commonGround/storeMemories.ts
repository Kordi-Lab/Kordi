// The Memories section of a card page (`memoryVersion` 2): the owner's memories on the open card,
// with Add to card…, Remove from card (`memoryVersion` 3) and Delete. Each change reloads the list
// and the card, so the "N new memories" line follows it.

import { useEffect, useState } from 'react';

import type { CommonGroundStore } from './store';
import type { CgProfile, CgRoutedMemory } from './types';

export type CgCardChoice = { profileId: string; label: string; on: boolean };

/** The checklist of Add to card…: the owner's other cards, checked when the memory is already on them. */
export function cardChoices(memory: CgRoutedMemory, profiles: CgProfile[], profileId: string): CgCardChoice[] {
  const on = new Set(memory.profileIds);
  return profiles
    .filter((profile) => profile.profileId !== profileId)
    .map((profile) => ({ profileId: profile.profileId, label: profile.name, on: on.has(profile.profileId) }));
}

export type CgMemoryHost = Pick<CommonGroundStore, 'client' | 'getSnapshot' | 'set' | 'run'>;

async function refreshOwner(host: CgMemoryHost, profileId: string) {
  const owner = await host.client.card(profileId).catch(() => null);
  if (owner && host.getSnapshot().profileId === profileId) host.set({ owner });
}

/** Adds a memory to `target`; it stays on this card and its other cards. */
export async function addMemoryToCard(host: CgMemoryHost, profileId: string, memoryId: string, target: string): Promise<boolean> {
  const added = await host.run('memory', async () => { await host.client.addMemoryToCard(memoryId, target); return true; });
  if (added) await refreshOwner(host, profileId);
  return Boolean(added);
}

/** Removes a memory from this card; it stays on its other cards. */
export async function removeMemoryFromCard(host: CgMemoryHost, profileId: string, memoryId: string): Promise<boolean> {
  const removed = await host.run('memory', async () => { await host.client.removeMemoryFromCard(memoryId, profileId); return true; });
  if (removed) await refreshOwner(host, profileId);
  return Boolean(removed);
}

/** Archives a memory; no card or agent reads it again. */
export async function removeMemory(host: CgMemoryHost, profileId: string, memoryId: string): Promise<boolean> {
  const removed = await host.run('memory', async () => { await host.client.removeMemory(memoryId); return true; });
  if (removed) await refreshOwner(host, profileId);
  return Boolean(removed);
}

export type ProfileMemories = {
  memories: CgRoutedMemory[];
  addToCard: (memoryId: string, target: string) => Promise<boolean>;
  removeFromCard: (memoryId: string) => Promise<boolean>;
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
    addToCard: (memoryId, target) => (profileId ? addMemoryToCard(host, profileId, memoryId, target).then(reload) : Promise.resolve(false)),
    removeFromCard: (memoryId) => (profileId ? removeMemoryFromCard(host, profileId, memoryId).then(reload) : Promise.resolve(false)),
    remove: (memoryId) => (profileId ? removeMemory(host, profileId, memoryId).then(reload) : Promise.resolve(false)),
  };
}

/** "3 new memories" filed since the card was built; null when there are none. */
export function newMemoriesLine(count: number | null | undefined): string | null {
  if (!count || count < 1) return null;
  return `${count} new ${count === 1 ? 'memory' : 'memories'}`;
}
