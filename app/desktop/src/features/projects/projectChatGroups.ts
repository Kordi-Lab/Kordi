import type { ChatProject } from './chatProjects';
import type { ChatSidebarRow } from '@/pages/sidebar/chatSidebarRows';

/** Group the visible rows without changing their session identity or fork ordering. */
export function projectChatGroups(
  rows: readonly ChatSidebarRow[],
  projects: readonly ChatProject[],
  collapsed: ReadonlySet<string>,
  includeEmptyProjects = false,
) {
  const projectBySession = new Map(projects.flatMap((project) =>
    project.sessions.map((session) => [session.id, project] as const)));
  const groups = new Map<string, { name: string; rows: ChatSidebarRow[] }>();
  for (const row of rows) {
    if (row.kind !== 'session') continue;
    const project = projectBySession.get(row.sessionId);
    const key = project?.id ?? 'unassigned';
    const group = groups.get(key) ?? { name: project?.name ?? 'Recents', rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (includeEmptyProjects) {
    for (const project of projects) {
      if (!groups.has(project.id)) groups.set(project.id, { name: project.name, rows: [] });
    }
  }
  // Recents is a separate, flat section after the project folders.
  const recents = groups.get('unassigned');
  if (recents) {
    groups.delete('unassigned');
    groups.set('unassigned', recents);
  }
  const groupedRows: ChatSidebarRow[] = [];
  for (const [key, group] of groups) {
    groupedRows.push({ kind: 'space', key: `project-group:${key}`, spaceId: key, depth: 0 });
    if (!collapsed.has(key)) {
      groupedRows.push(...group.rows);
    }
  }
  return { rows: groupedRows, groups, projectBySession };
}

/** A fork moved to another project becomes a top-level sidebar row; its transcript retains ancestry. */
export function projectScopedSidebarSessions<T extends {
  session: { id: string; forkedFromSessionId?: string | null; forkedFromMessageId?: string | null };
}>(rows: T[], projects: readonly ChatProject[]): T[] {
  const projectBySession = new Map(projects.flatMap((project) =>
    project.sessions.map((session) => [session.id, project.id] as const)));
  return rows.map((row) => {
    const parent = row.session.forkedFromSessionId;
    if (!parent || projectBySession.get(parent) === projectBySession.get(row.session.id)) return row;
    return { ...row, session: { ...row.session, forkedFromSessionId: null, forkedFromMessageId: null } };
  });
}
