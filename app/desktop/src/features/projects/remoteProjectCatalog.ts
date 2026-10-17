import { useEffect, useState, useSyncExternalStore } from 'react';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import type { RemoteProjectMembership } from '@/features/canonical/sessionResolver';
import type { DesktopProjectSettings } from '@/kordi-app/types';
import { invokeDesktop } from '@/lib/desktop';
import { PROJECTS_UPDATED_EVENT, projectCatalogRequest, projectID } from './projectSync';
import { desktopProjectImportApi } from './projectImportApi';

type CatalogProject = { id?: unknown; name?: unknown; sessions?: unknown; workspaces?: unknown };
type CatalogDevice = { id?: unknown; projects?: unknown };

const REFRESH_MS = 30_000;
const CATALOG_ID = /^[a-f0-9]{64}$/u;

function catalogWorkspaces(value: unknown, sessions: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const listed = new Set(sessions);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => listed.has(entry[0]) && typeof entry[1] === 'string' && CATALOG_ID.test(entry[1])));
}

/**
 * Projects other Macs on this account publish. Each Mac keeps its project list
 * locally, so a new Mac or app profile learns which synced sessions belong to
 * which project from these catalogs. A catalog entry whose ID matches a local
 * project root merges into that project.
 */
export function remoteProjectsFromCatalog(
  devices: unknown,
  ownDeviceId: string | null | undefined,
  localRootById: ReadonlyMap<string, string>,
): RemoteProjectMembership[] {
  const byId = new Map<string, RemoteProjectMembership>();
  for (const device of Array.isArray(devices) ? devices as CatalogDevice[] : []) {
    if (!device || (ownDeviceId && device.id === ownDeviceId) || !Array.isArray(device.projects)) continue;
    for (const project of device.projects as CatalogProject[]) {
      const id = typeof project?.id === 'string' ? project.id.trim() : '';
      const name = typeof project?.name === 'string' ? project.name.trim() : '';
      if (!id || !name || !Array.isArray(project.sessions)) continue;
      const sessions = project.sessions.filter((session): session is string => typeof session === 'string' && Boolean(session));
      const workspaces = catalogWorkspaces(project.workspaces, sessions);
      const existing = byId.get(id);
      if (existing) {
        existing.sessions = [...new Set([...existing.sessions, ...sessions])];
        existing.workspaces = { ...workspaces, ...existing.workspaces };
        continue;
      }
      byId.set(id, { id, name, sessions, localRoot: localRootById.get(id) ?? null, workspaces });
    }
  }
  return [...byId.values()];
}

// Chips read the worktree of a synced session from the latest catalog.
let catalogSnapshot: readonly RemoteProjectMembership[] = [];
const catalogListeners = new Set<() => void>();
function publishSnapshot(next: readonly RemoteProjectMembership[]) {
  catalogSnapshot = next;
  for (const listener of catalogListeners) listener();
}
function subscribe(listener: () => void) {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

export function __setRemoteProjectCatalogForTests(next: readonly RemoteProjectMembership[]) { publishSnapshot(next); }

/** Catalog ID of the worktree another Mac reports for this session, if any. */
export function useRemoteSessionWorkspaceId(sessionId: string) {
  const read = () => {
    for (const project of catalogSnapshot) {
      const workspace = project.workspaces?.[sessionId];
      if (workspace) return workspace;
    }
    return undefined;
  };
  return useSyncExternalStore(subscribe, read, read);
}

/** Register the local folder of a catalog project when it exists on this Mac. */
export function resolveRemoteProject(project: Pick<RemoteProjectMembership, 'id' | 'name'>, hints: readonly string[]) {
  return invokeDesktop<DesktopProjectSettings | null>('desktop_project_resolve_catalog', { catalogId: project.id, name: project.name, hints: [...hints] });
}

/** Ask for the project's folder on this Mac and bind it when it is the same folder. */
export async function locateRemoteProject(catalogId: string) {
  const folder = await desktopProjectImportApi.chooseFolder();
  if (!folder) return false;
  await invokeDesktop<DesktopProjectSettings>('desktop_project_locate_catalog', { catalogId, folderPath: folder });
  window.dispatchEvent(new Event(PROJECTS_UPDATED_EVENT));
  return true;
}

/**
 * Polls the account's project catalogs while the native shell is signed in and
 * binds each project whose folder exists on this Mac, as adding it manually does.
 */
export function useRemoteProjectCatalog(enabled: boolean, localRoots: readonly string[], folderHints: readonly string[] = []) {
  const [projects, setProjects] = useState<RemoteProjectMembership[] | null>(null);
  const rootsKey = JSON.stringify([...new Set(localRoots.map((root) => root.trim()).filter(Boolean))].sort());
  const hintsKey = JSON.stringify([...new Set(folderHints.map((hint) => hint?.trim()).filter(Boolean))].sort());
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let generation = 0;
    const roots = JSON.parse(rootsKey) as string[];
    const hints = [...new Set([...roots, ...JSON.parse(hintsKey) as string[]])];
    // One automatic search per project while the local folders stay the same.
    const searched = new Set<string>();
    const bindLocalFolders = async (catalog: RemoteProjectMembership[]) => {
      let bound = false;
      for (const project of catalog) {
        if (project.localRoot || searched.has(project.id) || stopped) continue;
        searched.add(project.id);
        try { bound = Boolean(await resolveRemoteProject(project, hints)) || bound; } catch { /* Unavailable until located. */ }
      }
      if (bound && !stopped) window.dispatchEvent(new Event(PROJECTS_UPDATED_EVENT));
    };
    const refresh = async () => {
      const current = ++generation;
      try {
        const session = await loadSession();
        if (!session?.token) { if (!stopped) { setProjects(null); publishSnapshot([]); } return; }
        const [catalog, ids] = await Promise.all([
          projectCatalogRequest<{ devices?: unknown }>(session.token, ''),
          Promise.all(roots.map(async (root) => [await projectID(root), root] as const)),
        ]);
        if (stopped || current !== generation || (await loadSession())?.token !== session.token) return;
        const next = remoteProjectsFromCatalog(catalog.devices, session.deviceId, new Map(ids));
        // Keep the previous array when nothing changed so the sidebar does not rebuild every poll.
        setProjects((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
        publishSnapshot(next);
        void bindLocalFolders(next);
      } catch { /* Older servers and offline periods keep the last known catalog. */ }
    };
    const update = () => { void refresh(); };
    // A different account must never see the previous account's catalog.
    const reset = () => { setProjects(null); publishSnapshot([]); void refresh(); };
    update();
    const timer = window.setInterval(update, REFRESH_MS);
    window.addEventListener(PROJECTS_UPDATED_EVENT, update);
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener(PROJECTS_UPDATED_EVENT, update);
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
    };
  }, [enabled, rootsKey, hintsKey]);
  return enabled ? projects ?? undefined : undefined;
}
