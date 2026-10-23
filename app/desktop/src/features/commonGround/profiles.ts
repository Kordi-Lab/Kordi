// Profile helpers: kind names, the current profile and its saved choice,
// which profile a room preselects, and how people show the profile they share.

import type { CgPerson, CgProfile, CgProfileKind, CgProfileTag } from './types';

export const MAX_PROFILES = 5;
export const PROFILE_NAME_MAX = 40;
export const PROFILE_FOCUS_MAX = 200;

export const PROFILE_KINDS: Array<[CgProfileKind, string]> = [
  ['work', 'Work'],
  ['health', 'Health'],
  ['daily', 'Daily'],
  ['custom', 'Custom'],
];

export function kindLabel(kind: CgProfileKind): string {
  return PROFILE_KINDS.find(([key]) => key === kind)?.[1] ?? 'Custom';
}

/** Fixed kinds the account already has; Custom is never taken. */
export function takenKinds(profiles: CgProfile[]): CgProfileKind[] {
  return profiles.map((profile) => profile.kind).filter((kind) => kind !== 'custom');
}

/** The saved choice when it still exists, else Work, else the first profile. */
export function pickProfile(profiles: CgProfile[], saved: string | null): string | null {
  if (saved && profiles.some((profile) => profile.profileId === saved)) return saved;
  return (profiles.find((profile) => profile.kind === 'work') ?? profiles[0])?.profileId ?? null;
}

/** Profiles that can be shared: those with a card. */
export function shareableProfiles(profiles: CgProfile[]): CgProfile[] {
  return profiles.filter((profile) => profile.hasCard);
}

/**
 * The profile a Share sheet starts on: the current one when it already fits the room's kind,
 * else a built profile of that kind, else the current one, else the first with a card.
 */
export function sharePreselect(profiles: CgProfile[], options: { kind?: CgProfileKind | null; current?: string | null }): string | null {
  const shareable = shareableProfiles(profiles);
  const current = shareable.find((profile) => profile.profileId === options.current);
  if (options.kind && current?.kind !== options.kind) {
    const ofKind = shareable.find((profile) => profile.kind === options.kind);
    if (ofKind) return ofKind.profileId;
  }
  return current?.profileId ?? shareable[0]?.profileId ?? null;
}

/** "Nadia · Health": a person with the profile they share, unless it is Work. */
export function personTitle(person: Pick<CgPerson, 'name' | 'profile'>): string {
  const profile = person.profile;
  return profile && profile.kind !== 'work' && profile.name ? `${person.name} · ${profile.name}` : person.name;
}

/** "Build your Health profile", or "Build your profile" for Work and before profiles. */
export function buildTitle(profile: Pick<CgProfileTag, 'kind' | 'name'> | null | undefined): string {
  return profile && profile.kind !== 'work' ? `Build your ${profile.name} profile` : 'Build your profile';
}

/** A per-account key for the current profile. */
export function profileStorageKey(accountId: string): string {
  return `kordi.commonGround.profile.v1:${accountId}`;
}

export type CgProfileMemory = { read: () => string | null; write: (profileId: string | null) => void };

/** The current profile in localStorage, ignoring storage that is off. */
export function localProfileMemory(accountId: string): CgProfileMemory {
  const key = profileStorageKey(accountId);
  return {
    read: () => {
      try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
    },
    write: (profileId) => {
      try {
        if (profileId) globalThis.localStorage?.setItem(key, profileId);
        else globalThis.localStorage?.removeItem(key);
      } catch { /* storage off */ }
    },
  };
}

/** The line a rename refuses, or null: a custom card needs a name; a fixed kind's empty name restores its default. */
export function renameError(kind: CgProfileKind, name: string): string | null {
  return kind === 'custom' && !name.trim() ? 'A custom card needs a name.' : null;
}

/** The fields a rename sends: an emptied name goes as '' so the server restores the kind's default. */
export function renamePatch(profile: { name: string; focus: string | null }, name: string, focus: string): { name?: string; focus?: string } {
  const patch: { name?: string; focus?: string } = {};
  if (name !== profile.name) patch.name = name;
  if (focus !== (profile.focus ?? '')) patch.focus = focus;
  return patch;
}
