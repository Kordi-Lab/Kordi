import {
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudAuthClient,
} from '@/features/cloud/authClient';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import { CloudMemoryClient, type CloudMemory, type CloudMemoryPatch, type CloudMemorySettings } from '@/features/cloud/cloudMemoryClient';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { createCommonGroundClient, isRouteMissing } from '@/features/commonGround/client';
import { loadSession, type StoredSession } from '@/features/cloud/session';
import {
  desktopMemoryForgetLocal,
  desktopMemoryListLocal,
  desktopMemorySettings,
  desktopMemorySync,
  desktopMemoryUpdateSettings,
  type DesktopLocalMemory,
  type DesktopMemorySettings,
} from '@/lib/desktopMemory';
import { isNativeDesktopShell } from '@/lib/desktop';

import { isMemoryCategory } from './memoryCategory';
import type { MemoryClient } from './memoryClient';
import { loadMemoryOriginSources, type MemoryOriginSources } from './memoryOrigin';
import type { MemoryCard } from './memoryOrganizerModel';
import {
  NOT_A_GROUP_MEMBER_MESSAGE,
  type MemoryLesson,
  type MemoryLessonScope,
  type MemorySettings,
} from './memoryModel';

export type AccountMemoryAuthClient = Pick<CloudAuthClient, 'request' | 'me'>;

/** The account memory routes the client calls. */
export type AccountMemoryRoutes = Pick<
  CloudMemoryClient,
  'list' | 'create' | 'update' | 'remove' | 'forgetAll' | 'settings' | 'updateSettings'
> & Partial<Pick<CloudMemoryClient, 'patch'>>;

/** Memory commands of the desktop shell. They only exist in the native shell. */
export type AccountMemoryDesktop = {
  isNativeShell(): boolean;
  settings(): Promise<DesktopMemorySettings>;
  updateSettings(patch: Partial<DesktopMemorySettings>): Promise<DesktopMemorySettings>;
  sync(): Promise<unknown>;
  listLocal(): Promise<DesktopLocalMemory[]>;
  forgetLocal(): Promise<unknown>;
};

export type AccountMemoryClientOptions = {
  authClient?: AccountMemoryAuthClient;
  memoryRoutes?: AccountMemoryRoutes;
  loadSession?: () => Promise<StoredSession | null>;
  desktop?: AccountMemoryDesktop;
  now?: () => number;
  /** The owner's Grounding cards; defaults to the common ground profiles route. */
  loadCards?: () => Promise<MemoryCard[]>;
  /** The chats and groups that name memory origins; defaults to the ones on this Mac. */
  loadOriginSources?: (accountId: string | null) => Promise<MemoryOriginSources>;
};

export const SIGN_IN_TO_EDIT_MEMORIES = 'Sign in to edit memories.';

const DEFAULT_SETTINGS: MemorySettings = { lessonsEnabled: true, excludeSensitive: true };

const fallbackScopeLabels: Record<MemoryLessonScope, string> = {
  global: 'Global',
  conversation: 'Conversation',
  project: 'Project',
  group: 'Group',
};

/** The owner's common ground profiles; a server without profiles has no cards. */
async function commonGroundCards(): Promise<MemoryCard[]> {
  try {
    const profiles = await createCommonGroundClient().profiles();
    return profiles.map(({ profileId, kind, name }) => ({ profileId, kind, name }));
  } catch (caught) {
    if (isRouteMissing(caught)) return [];
    throw caught;
  }
}

const nativeDesktop: AccountMemoryDesktop = {
  isNativeShell: isNativeDesktopShell,
  settings: desktopMemorySettings,
  updateSettings: desktopMemoryUpdateSettings,
  sync: desktopMemorySync,
  listLocal: desktopMemoryListLocal,
  forgetLocal: desktopMemoryForgetLocal,
};

type RoutingFields = Pick<
  CloudMemory,
  'category' | 'declarationType' | 'confidence' | 'profileId' | 'profileKind' | 'profileIds' | 'excludedProfileIds'
>;

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Copies the routing fields a server sent; an unknown category is dropped so the row shows no chip. */
function withRouting(lesson: MemoryLesson, entry: RoutingFields): MemoryLesson {
  if (isMemoryCategory(entry.category)) lesson.category = entry.category;
  if (entry.declarationType) lesson.declarationType = entry.declarationType;
  if (entry.confidence !== undefined) lesson.confidence = entry.confidence;
  if (entry.profileId !== undefined) lesson.profileId = entry.profileId;
  if (entry.profileKind !== undefined) lesson.profileKind = entry.profileKind;
  const profileIds = idList(entry.profileIds);
  if (profileIds) lesson.profileIds = profileIds;
  const excludedProfileIds = idList(entry.excludedProfileIds);
  if (excludedProfileIds) lesson.excludedProfileIds = excludedProfileIds;
  return lesson;
}

function toLesson(entry: RoutingFields & {
  lessonId: string;
  scope: MemoryLessonScope;
  scopeId: string;
  scopeLabel: string | null;
  source: MemoryLesson['source'];
  text: string;
  createdAt: string;
  updatedAt: string;
  ownerAccountId?: string;
  ownerName?: string | null;
}): MemoryLesson {
  const lesson: MemoryLesson = {
    lessonId: entry.lessonId,
    scope: entry.scope,
    scopeId: entry.scopeId,
    scopeLabel: entry.scopeLabel?.trim() || fallbackScopeLabels[entry.scope],
    source: entry.source,
    text: entry.text,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  if (entry.ownerAccountId) {
    lesson.ownerAccountId = entry.ownerAccountId;
    lesson.ownerName = entry.ownerName?.trim() || null;
  }
  return withRouting(lesson, entry);
}

/** The server answers 403 `not_a_group_member` when someone outside the group edits a group memory. */
async function asGroupMember<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (caught) {
    if (caught instanceof CloudAuthError && caught.status === 403 && caught.code === 'not_a_group_member') {
      throw new Error(NOT_A_GROUP_MEMBER_MESSAGE);
    }
    throw caught;
  }
}

function fromWireSettings(settings: CloudMemorySettings | DesktopMemorySettings): MemorySettings {
  return { lessonsEnabled: settings.memoryEnabled, excludeSensitive: settings.excludeSensitive };
}

function toWirePatch(patch: Partial<MemorySettings>): Partial<CloudMemorySettings> {
  const wire: Partial<CloudMemorySettings> = {};
  if (patch.lessonsEnabled !== undefined) wire.memoryEnabled = patch.lessonsEnabled;
  if (patch.excludeSensitive !== undefined) wire.excludeSensitive = patch.excludeSensitive;
  return wire;
}

function accountLabelOf(account: CloudAccount | null): string {
  if (!account) return '';
  return account.primaryEmail?.trim()
    || account.displayName?.trim()
    || formatKordiHandle(account.kordiId)
    || '';
}

/**
 * Memory client backed by the account memory routes. The native shell keeps a
 * cache of the memories on this Mac, so every successful load or write asks it
 * to sync without blocking the settings page. Signed out, the client reads the
 * cache on this Mac and does not allow edits.
 */
export function createAccountMemoryClient(options: AccountMemoryClientOptions = {}): MemoryClient {
  let authClient = options.authClient ?? null;
  let memoryRoutes = options.memoryRoutes ?? null;
  const readSession = options.loadSession ?? loadSession;
  const desktop = options.desktop ?? nativeDesktop;
  const now = options.now ?? Date.now;
  const loadCards = options.loadCards ?? commonGroundCards;
  const loadOriginSources = options.loadOriginSources ?? loadMemoryOriginSources;
  let lastSynced: { accountId: string; at: string } | null = null;
  let pendingList: Promise<unknown> | null = null;
  let cachedAccount: { token: string; account: Promise<CloudAccount | null> } | null = null;

  const auth = (): AccountMemoryAuthClient => {
    authClient ??= defaultCloudAuthClient();
    return authClient;
  };
  const memory = (): AccountMemoryRoutes => {
    memoryRoutes ??= new CloudMemoryClient((path, init, fallback) => auth().request(path, init, fallback));
    return memoryRoutes;
  };

  const session = async (): Promise<StoredSession | null> => {
    try {
      const stored = await readSession();
      return stored?.token ? stored : null;
    } catch {
      return null;
    }
  };

  const requireSession = async (): Promise<StoredSession> => {
    const stored = await session();
    if (!stored) throw new Error(SIGN_IN_TO_EDIT_MEMORIES);
    return stored;
  };

  const markSynced = (stored: StoredSession) => {
    lastSynced = { accountId: stored.accountId, at: new Date(now()).toISOString() };
  };

  // Fire and forget: outside the native shell, or before the command exists, nothing happens.
  const background = (run: () => Promise<unknown>) => {
    if (!desktop.isNativeShell()) return;
    void Promise.resolve().then(run).catch(() => undefined);
  };

  const syncDesktop = () => background(() => desktop.sync());

  const mirrorSettings = (settings: CloudMemorySettings) => background(() => desktop.updateSettings(settings));

  const localSettings = async (): Promise<MemorySettings> => {
    if (!desktop.isNativeShell()) return { ...DEFAULT_SETTINGS };
    try {
      return fromWireSettings(await desktop.settings());
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  };

  const patchLesson = async (lessonId: string, patch: CloudMemoryPatch): Promise<MemoryLesson> => {
    const stored = await requireSession();
    const routes = memory();
    if (!routes.patch) throw new Error('Could not change this memory.');
    const { memoryId, ...rest } = await routes.patch(stored.token, lessonId, patch);
    markSynced(stored);
    syncDesktop();
    return toLesson({ lessonId: memoryId, ...rest });
  };

  const listLessons = async (): Promise<MemoryLesson[]> => {
    const stored = await session();
    if (!stored) {
      if (!desktop.isNativeShell()) return [];
      return (await desktop.listLocal()).map(toLesson);
    }
    const response = await memory().list(stored.token);
    markSynced(stored);
    syncDesktop();
    return response.memories.map(({ memoryId, ...rest }) => toLesson({ lessonId: memoryId, ...rest }));
  };

  return {
    async settings() {
      const stored = await session();
      if (!stored) return localSettings();
      const settings = await memory().settings(stored.token);
      mirrorSettings(settings);
      return fromWireSettings(settings);
    },
    async updateSettings(patch) {
      const wire = toWirePatch(patch);
      const stored = await session();
      if (!stored) {
        if (!desktop.isNativeShell()) throw new Error(SIGN_IN_TO_EDIT_MEMORIES);
        return fromWireSettings(await desktop.updateSettings(wire));
      }
      const settings = await memory().updateSettings(stored.token, wire);
      markSynced(stored);
      mirrorSettings(settings);
      return fromWireSettings(settings);
    },
    listLessons() {
      const listing = listLessons();
      pendingList = listing;
      return listing;
    },
    async createLesson(target, text) {
      const stored = await requireSession();
      const { memoryId, ...rest } = await asGroupMember(memory().create(stored.token, {
        scope: target.scope,
        scopeId: target.scopeId,
        scopeLabel: target.scopeLabel?.trim() || null,
        source: 'manual',
        text,
      }));
      markSynced(stored);
      syncDesktop();
      return toLesson({ lessonId: memoryId, ...rest });
    },
    async importLesson(save) {
      const stored = await requireSession();
      const { memoryId, ...rest } = await memory().create(stored.token, save);
      markSynced(stored);
      syncDesktop();
      return toLesson({ lessonId: memoryId, ...rest });
    },
    async updateLesson(lessonId, text) {
      const stored = await requireSession();
      const { memoryId, ...rest } = await asGroupMember(memory().update(stored.token, lessonId, text));
      markSynced(stored);
      syncDesktop();
      return toLesson({ lessonId: memoryId, ...rest });
    },
    updateMemoryCategory(lessonId, category) {
      return patchLesson(lessonId, { category });
    },
    addMemoryToCard(lessonId, profileId) {
      return patchLesson(lessonId, { addProfileId: profileId });
    },
    removeMemoryFromCard(lessonId, profileId) {
      return patchLesson(lessonId, { removeProfileId: profileId });
    },
    async listCards() {
      if (!(await session())) return [];
      return loadCards();
    },
    async originSources() {
      return loadOriginSources((await session())?.accountId ?? null);
    },
    async archiveLesson(lessonId) {
      const stored = await requireSession();
      await asGroupMember(memory().remove(stored.token, lessonId));
      markSynced(stored);
      syncDesktop();
    },
    async forgetAll() {
      const stored = await requireSession();
      const result = await memory().forgetAll(stored.token);
      markSynced(stored);
      // Pending memories on this Mac would upload again on the next sync.
      if (desktop.isNativeShell()) await desktop.forgetLocal();
      syncDesktop();
      return { archived: result.archived };
    },
    async viewerAccountId() {
      return (await session())?.accountId ?? null;
    },
    async syncState() {
      // The page loads the list and the sync row together, so wait for the list.
      await pendingList?.catch(() => undefined);
      const stored = await session();
      if (!stored) return { accountLabel: '', lastSyncedAt: null };
      if (cachedAccount?.token !== stored.token) {
        cachedAccount = { token: stored.token, account: auth().me(stored.token).catch(() => null) };
      }
      const account = await cachedAccount.account;
      if (!account) cachedAccount = null;
      return {
        accountLabel: accountLabelOf(account),
        lastSyncedAt: lastSynced?.accountId === stored.accountId ? lastSynced.at : null,
      };
    },
  };
}
