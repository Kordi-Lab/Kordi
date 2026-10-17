import { useEffect, useState } from 'react';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import type { RemoteProjectMembership } from '@/features/canonical/sessionResolver';
import { PROJECTS_UPDATED_EVENT, projectCatalogRequest, projectID } from './projectSync';

type CatalogProject = { id?: unknown; name?: unknown; sessions?: unknown };
type CatalogDevice = { id?: unknown; projects?: unknown };

const REFRESH_MS = 30_000;

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
      const existing = byId.get(id);
      if (existing) {
        existing.sessions = [...new Set([...existing.sessions, ...sessions])];
        continue;
      }
      byId.set(id, { id, name, sessions, localRoot: localRootById.get(id) ?? null });
    }
  }
  return [...byId.values()];
}

/** Polls the account's project catalogs while the native shell is signed in. */
export function useRemoteProjectCatalog(enabled: boolean, localRoots: readonly string[]) {
  const [projects, setProjects] = useState<RemoteProjectMembership[] | null>(null);
  const rootsKey = JSON.stringify([...new Set(localRoots.map((root) => root.trim()).filter(Boolean))].sort());
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let generation = 0;
    const roots = JSON.parse(rootsKey) as string[];
    const refresh = async () => {
      const current = ++generation;
      try {
        const session = await loadSession();
        if (!session?.token) { if (!stopped) setProjects(null); return; }
        const [catalog, ids] = await Promise.all([
          projectCatalogRequest<{ devices?: unknown }>(session.token, ''),
          Promise.all(roots.map(async (root) => [await projectID(root), root] as const)),
        ]);
        if (stopped || current !== generation || (await loadSession())?.token !== session.token) return;
        const next = remoteProjectsFromCatalog(catalog.devices, session.deviceId, new Map(ids));
        // Keep the previous array when nothing changed so the sidebar does not rebuild every poll.
        setProjects((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } catch { /* Older servers and offline periods keep the last known catalog. */ }
    };
    const update = () => { void refresh(); };
    // A different account must never see the previous account's catalog.
    const reset = () => { setProjects(null); void refresh(); };
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
  }, [enabled, rootsKey]);
  return enabled ? projects ?? undefined : undefined;
}
