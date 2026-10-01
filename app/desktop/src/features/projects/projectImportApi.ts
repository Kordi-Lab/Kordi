import { createDesktopProjectFromFolder, invokeDesktop } from '@/lib/desktop';
import type { DesktopProjectSettings } from '@/kordi-app/types';

export type GithubRepository = { fullName: string; description: string | null; language: string | null; private: boolean };
export type GithubRepositoryPage = { repositories: GithubRepository[]; hasMore: boolean };
export type ProjectImportApi = {
  chooseFolder: () => Promise<string | null>;
  repositories: (page: number) => Promise<GithubRepositoryPage>;
  addLocal: (path: string) => Promise<Pick<DesktopProjectSettings, 'root' | 'name'>>;
  clone: (repository: string, parentDir?: string) => Promise<Pick<DesktopProjectSettings, 'root' | 'name'>>;
};
export const desktopProjectImportApi: ProjectImportApi = {
  chooseFolder: () => invokeDesktop<string | null>('desktop_project_choose_folder'),
  repositories: (page) => invokeDesktop<GithubRepositoryPage>('desktop_project_github_repositories', { page }),
  addLocal: (path) => createDesktopProjectFromFolder(path),
  clone: (repository, parentDir) => invokeDesktop<DesktopProjectSettings>('desktop_project_clone_github', { repository, parentDir }),
};

export function githubRepositoryFromInput(input: string): string | null {
  const value = input.trim().replace(/\/$/, '').replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '');
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/.test(part) && part !== '.' && part !== '..') ? value : null;
}
