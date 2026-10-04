import { invokeDesktop } from '@/lib/desktop';

export type GitWorktree = { path: string; branch: string | null };
export type GitWorkspace = {
  branch: string | null;
  branches: string[];
  worktrees: GitWorktree[];
  workspaceRoot: string;
  isWorktree: boolean;
};
export type ChatWorkspaceSelection = { worktree?: boolean; branch?: string; workspaceRoot?: string };

export function fetchGitWorkspace(projectRoot: string, workspaceRoot?: string) {
  return invokeDesktop<GitWorkspace | null>('desktop_project_git_workspace', { projectRoot, workspaceRoot });
}
