import { useEffect } from 'react';
import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { loadSession } from '@/features/cloud/session';
import { fetchDesktopChatState, invokeDesktop, createDesktopProjectSession, moveDesktopChatSessionToProject } from '@/lib/desktop';
import { adoptedProjectSessionIds } from './adoptedProjectSessions';
import { desktopProjectImportApi, githubRepositoryFromInput } from './projectImportApi';

export const PROJECTS_UPDATED_EVENT = 'kordi-projects-updated';
type Operation = { id: string; request: { action: string; projectId?: string; sessionId?: string; repository?: string; page?: number } };
/** Opaque catalog ID of a project root; the root itself never leaves this Mac. */
export async function projectID(root: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
async function catalog() {
  const state = await fetchDesktopChatState();
  return Promise.all((state?.projects ?? []).map(async (project) => ({
    id: await projectID(project.root), name: project.name, sessions: project.sessions.map((session) => session.id), root: project.root,
  })));
}
type PublishedProject = { id: string; name: string; sessions: string[]; workspaces?: Record<string, string> };
let workspacesUnsupportedUntil = 0;
/** Worktree sessions publish an opaque worktree ID so other Macs can show the same branch. */
async function publishedCatalog(): Promise<PublishedProject[]> {
  // Sessions run here for an offline project Mac stay listed by that Mac only.
  const adopted = adoptedProjectSessionIds();
  const projects = (await catalog()).map((project) => ({ ...project, sessions: project.sessions.filter((session) => !adopted.has(session)) }));
  let ids: Record<string, unknown> = {};
  if (Date.now() >= workspacesUnsupportedUntil) {
    try {
      const result = await invokeDesktop<Record<string, unknown> | null>('desktop_project_session_workspace_ids', { sessionIds: projects.flatMap((project) => project.sessions) });
      if (result && typeof result === 'object') ids = result;
    } catch { /* Older desktop runtimes publish membership only. */ }
  }
  return projects.map(({ id, name, sessions }) => {
    const workspaces = Object.fromEntries(sessions.flatMap((session) => {
      const workspace = Object.prototype.hasOwnProperty.call(ids, session) ? ids[session] : undefined;
      return typeof workspace === 'string' && /^[a-f0-9]{64}$/u.test(workspace) ? [[session, workspace]] : [];
    }));
    return Object.keys(workspaces).length ? { id, name, sessions, workspaces } : { id, name, sessions };
  });
}
/** Servers released before worktree IDs reject the field; publish membership alone there. */
async function publishCatalog(token: string) {
  const projects = await publishedCatalog();
  try {
    await projectCatalogRequest(token, '', 'PUT', { projects });
  } catch (error) {
    if (!projects.some((project) => project.workspaces)) throw error;
    await projectCatalogRequest(token, '', 'PUT', { projects: projects.map(({ workspaces: _workspaces, ...project }) => project) });
    // Retry with worktree IDs later so an updated server picks them up without a restart.
    workspacesUnsupportedUntil = Date.now() + 10 * 60_000;
  }
}
export async function projectCatalogRequest<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${cloudApiBaseUrl()}/v1/cloud/projects${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Project sync is unavailable.');
  return response.json() as Promise<T>;
}
async function execute(operation: Operation, stillSignedIn: () => Promise<boolean>) {
  const input = operation.request;
  if (input.action === 'repositories') return desktopProjectImportApi.repositories(input.page ?? 1);
  if (input.action === 'importFolder' || input.action === 'cloneRepository') {
    let project;
    if (input.action === 'importFolder') {
      const folder = await desktopProjectImportApi.chooseFolder();
      if (!folder) return { cancelled: true };
      if (!await stillSignedIn()) throw new Error('Account changed.');
      project = await desktopProjectImportApi.addLocal(folder);
    } else {
      const repo = githubRepositoryFromInput(input.repository ?? '');
      if (!repo) throw new Error('Invalid GitHub repository.');
      project = await desktopProjectImportApi.clone(repo);
    }
    return { projectId: await projectID(project.root) };
  }
  if (input.action !== 'assign') throw new Error('Unsupported project action.');
  const projects = await catalog();
  const project = projects.find((entry) => entry.id === input.projectId);
  if (input.projectId && !project) throw new Error('Project is unavailable.');
  let state;
  if (input.sessionId) {
    await invokeDesktop('desktop_project_prepare_remote_session', { sessionId: input.sessionId });
    state = await moveDesktopChatSessionToProject(input.sessionId, project?.root ?? '');
  } else {
    if (!project) throw new Error('Choose a project first.');
    state = await createDesktopProjectSession(project.root);
  }
  return { sessionId: state?.activeSessionId };
}

/** Mounted once per native shell. Operations are never replayed after a lost acknowledgement. */
export function useProjectSync(enabled: boolean, accountId: string | undefined) {
  useEffect(() => {
    if (!enabled || !accountId) return;
    let stopped = false;
    let busy = false;
    let publishing = false;
    const publish = async () => {
      if (publishing || busy || stopped) return;
      publishing = true;
      try {
        const session = await loadSession();
        if (!session?.deviceId || session.accountId !== accountId) return;
        if (!stopped && (await loadSession())?.token === session.token) await publishCatalog(session.token);
      } catch { /* Older servers and temporary disconnections must leave local projects usable. */ }
      finally { publishing = false; }
    };
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const session = await loadSession();
        if (!session?.deviceId || session.accountId !== accountId) return;
        const { command } = await projectCatalogRequest<{ command: Operation | null }>(session.token, '/commands/next', 'POST');
        if (!command || stopped || (await loadSession())?.token !== session.token) return;
        let result: unknown;
        let failed = false;
        try { result = await execute(command, async () => !stopped && (await loadSession())?.token === session.token); }
        catch { failed = true; result = { message: 'The project action failed on your Mac. Check that the folder exists and GitHub is connected, then try again.' }; }
        if (stopped || (await loadSession())?.token !== session.token) return;
        // Publish membership before acknowledging so iOS cannot send into the old workspace.
        await publishCatalog(session.token);
        await projectCatalogRequest(session.token, `/commands/${command.id}`, 'PUT', { result, failed });
        window.dispatchEvent(new Event(PROJECTS_UPDATED_EVENT));
      } catch { /* A failed transport never repeats a potentially completed clone or move. */ }
      finally { busy = false; }
    };
    void publish().then(tick);
    const heartbeat = window.setInterval(() => {
      if (busy) {
        void loadSession().then((session) => session?.deviceId && session.accountId === accountId ? projectCatalogRequest(session.token, '/heartbeat', 'POST') : undefined).catch(() => undefined);
      } else { void publish(); }
    }, 10000);
    const commands = window.setInterval(() => { void tick(); }, 3000);
    return () => { stopped = true; window.clearInterval(heartbeat); window.clearInterval(commands); };
  }, [enabled, accountId]);
}
