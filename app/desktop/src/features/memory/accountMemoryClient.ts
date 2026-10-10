import {
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudAuthClient,
} from '@/features/cloud/authClient';
import { CloudMemoryClient, type CloudMemorySettings } from '@/features/cloud/cloudMemoryClient';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { loadSession, type StoredSession } from '@/features/cloud/session';
import {
  desktopMemoryListLocal,
  desktopMemorySettings,
  desktopMemorySync,
  desktopMemoryUpdateSettings,
  type DesktopLocalMemory,
  type DesktopMemorySettings,
} from '@/lib/desktopMemory';
import { isNativeDesktopShell } from '@/lib/desktop';

import type { MemoryClient } from './memoryClient';
import type { MemoryLesson, MemoryLessonScope, MemorySettings } from './memoryModel';

export type AccountMemoryAuthClient = Pick<CloudAuthClient, 'request' | 'me'>;

/** The account memory routes the client calls. */
export type AccountMemoryRoutes = Pick<
  CloudMemoryClient,
  'list' | 'update' | 'remove' | 'forgetAll' | 'settings' | 'updateSettings'
>;

/** Memory commands of the desktop shell. They only exist in the native shell. */
export type AccountMemoryDesktop = {
  isNativeShell(): boolean;
  settings(): Promise<DesktopMemorySettings>;
  updateSettings(patch: Partial<DesktopMemorySettings>): Promise<DesktopMemorySettings>;
  sync(): Promise<unknown>;
  listLocal(): Promise<DesktopLocalMemory[]>;
};

export type AccountMemoryClientOptions = {
  authClient?: AccountMemoryAuthClient;
  memoryRoutes?: AccountMemoryRoutes;
  loadSession?: () => Promise<StoredSession | null>;
  desktop?: AccountMemoryDesktop;
  now?: () => number;
};

export const SIGN_IN_TO_EDIT_MEMORIES = 'Sign in to edit memories.';

const DEFAULT_SETTINGS: MemorySettings = { lessonsEnabled: true, excludeSensitive: true };

const fallbackScopeLabels: Record<MemoryLessonScope, string> = {
  conversation: 'Conversation',
  project: 'Project',
  group: 'Group',
};

const nativeDesktop: AccountMemoryDesktop = {
  isNativeShell: isNativeDesktopShell,
  settings: desktopMemorySettings,
  updateSettings: desktopMemoryUpdateSettings,
  sync: desktopMemorySync,
  listLocal: desktopMemoryListLocal,
};

function toLesson(entry: {
  lessonId: string;
  scope: MemoryLessonScope;
  scopeId: string;
  scopeLabel: string | null;
  source: MemoryLesson['source'];
  text: string;
  createdAt: string;
  updatedAt: string;
}): MemoryLesson {
  return {
    lessonId: entry.lessonId,
    scope: entry.scope,
    scopeId: entry.scopeId,
    scopeLabel: entry.scopeLabel?.trim() || fallbackScopeLabels[entry.scope],
    source: entry.source,
    text: entry.text,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
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
    async updateLesson(lessonId, text) {
      const stored = await requireSession();
      const { memoryId, ...rest } = await memory().update(stored.token, lessonId, text);
      markSynced(stored);
      syncDesktop();
      return toLesson({ lessonId: memoryId, ...rest });
    },
    async archiveLesson(lessonId) {
      const stored = await requireSession();
      await memory().remove(stored.token, lessonId);
      markSynced(stored);
      syncDesktop();
    },
    async forgetAll() {
      const stored = await requireSession();
      const result = await memory().forgetAll(stored.token);
      markSynced(stored);
      syncDesktop();
      return { archived: result.archived };
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
