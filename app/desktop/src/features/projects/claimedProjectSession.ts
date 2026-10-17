import { fetchDesktopChatState, invokeDesktop, moveDesktopChatSessionToProject } from '@/lib/desktop';
import { fetchGitWorkspace, type ChatWorkspaceSelection } from './gitWorkspace';
import { rememberAdoptedProjectSession } from './adoptedProjectSessions';
import { projectID } from './projectSync';

/** The project of a session the server let this Mac run, from the claim response. */
export type ClaimedProject = { id: string; name: string; workspaceId?: string };

const CATALOG_ID = /^[a-f0-9]{64}$/u;

export function claimedProjectFromLease(value: unknown): ClaimedProject | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { id, name, workspaceId } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !CATALOG_ID.test(id)) return undefined;
  return {
    id,
    name: typeof name === 'string' && name.trim() ? name.trim() : 'this project',
    ...(typeof workspaceId === 'string' && CATALOG_ID.test(workspaceId) ? { workspaceId } : {}),
  };
}

/**
 * Puts a claimed project session in this Mac's folder of the same project, and
 * in the same worktree when there is one, before its turn runs. Returns false
 * when the folder is not on this Mac, so the turn never runs without the files.
 */
export async function bindClaimedProjectSession(sessionId: string, project: ClaimedProject): Promise<boolean> {
  const state = await fetchDesktopChatState();
  const local = await Promise.all((state?.projects ?? []).map(async (entry) => ({ entry, id: await projectID(entry.root) })));
  const match = local.find(({ id }) => id === project.id)?.entry;
  if (!match) return false;
  if (match.sessions.some((session) => session.id === sessionId)) return true;
  let workspace: ChatWorkspaceSelection | undefined;
  if (project.workspaceId) {
    const git = await fetchGitWorkspace(match.root, undefined, project.workspaceId).catch(() => null);
    if (git?.isWorktree && git.workspaceRoot) workspace = { worktree: true, workspaceRoot: git.workspaceRoot, ...(git.branch ? { branch: git.branch } : {}) };
  }
  await invokeDesktop('desktop_project_prepare_remote_session', { sessionId });
  await moveDesktopChatSessionToProject(sessionId, match.root, workspace);
  rememberAdoptedProjectSession(sessionId);
  return true;
}
