import type { ChatProject } from './chatProjects';
import type { ChatSidebarRow } from '@/pages/sidebar/chatSidebarRows';

/** Group the visible rows without changing their session identity or fork ordering. */
export function projectChatGroups(
  rows: readonly ChatSidebarRow[],
  projects: readonly ChatProject[],
  collapsed: ReadonlySet<string>,
  includeEmptyProjects = false,
  options: {
    pinnedSessionIds?: ReadonlySet<string>;
    expandedProjectIds?: ReadonlySet<string>;
    previewLimit?: number;
  } = {},
) {
  const projectBySession = new Map(projects.flatMap((project) =>
    project.sessions.map((session) => [session.id, project] as const)));
  const groups = new Map<string, { name: string; rows: ChatSidebarRow[] }>();
  const pinned: ChatSidebarRow[] = [];
  const recents: ChatSidebarRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'session') continue;
    if (options.pinnedSessionIds?.has(row.sessionId)) pinned.push(row);
    else recents.push(row);
    const project = projectBySession.get(row.sessionId);
    if (!project) continue;
    const key = project.id;
    const group = groups.get(key) ?? { name: project.name, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (includeEmptyProjects) {
    for (const project of projects) {
      if (!groups.has(project.id)) groups.set(project.id, { name: project.name, rows: [] });
    }
  }
  const groupedRows: ChatSidebarRow[] = [];
  const appendSection = (id: string) => groupedRows.push({
    kind: 'space', key: `agent-section:${id}`, spaceId: `section:${id}`, depth: 0,
    estimatedHeight: groupedRows.length ? 36 : 28,
  });
  const appendSessions = (items: ChatSidebarRow[], section: string, flat = false) => {
    for (const row of items) groupedRows.push({
      ...row, key: `${section}:${row.key}`, ...(flat ? { depth: 0 } : {}),
    });
  };
  if (pinned.length) {
    appendSection('pinned');
    appendSessions(pinned, 'pinned', true);
  }
  if (groups.size || includeEmptyProjects) appendSection('projects');
  const limitedProjectIds = new Set<string>();
  for (const [key, group] of groups) {
    groupedRows.push({ kind: 'space', key: `project-group:${key}`, spaceId: key, depth: 0 });
    if (!collapsed.has(key)) {
      const limit = options.previewLimit ?? Infinity;
      let roots = 0;
      const previewRows = group.rows.filter((row) => {
        if (row.depth === 0) roots += 1;
        return roots <= limit;
      });
      const limited = previewRows.length < group.rows.length;
      appendSessions(options.expandedProjectIds?.has(key) ? group.rows : previewRows, `project:${key}`);
      if (limited) {
        limitedProjectIds.add(key);
        groupedRows.push({ kind: 'space', key: `project-more:${key}`, spaceId: key, depth: 0 });
      }
    }
  }
  if (recents.length) {
    appendSection('recents');
    if (!collapsed.has('section:recents')) appendSessions(recents, 'recent');
  }
  return { rows: groupedRows, groups, projectBySession, limitedProjectIds };
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
