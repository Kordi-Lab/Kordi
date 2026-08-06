export type ChatSidebarRow =
  | { kind: 'space'; key: string; spaceId: string; depth: number }
  | {
      kind: 'session';
      key: string;
      sessionId: string;
      spaceId: string;
      depth: number;
      activePath: boolean;
    };

export type ChatSidebarSpaceInput = {
  spaceId: string;
  expanded: boolean;
  rootSessionIds: readonly string[];
};

export type ChatSidebarSessionInput = {
  sessionId: string;
  spaceId: string;
  parentSessionId?: string | null;
};

export function buildChatSidebarRows({
  spaces,
  sessions,
  collapsedForkParentIds,
  activeSessionId,
  includeSpaceRows,
}: {
  spaces: readonly ChatSidebarSpaceInput[];
  sessions: readonly ChatSidebarSessionInput[];
  collapsedForkParentIds: ReadonlySet<string>;
  activeSessionId?: string | null;
  includeSpaceRows: boolean;
}): ChatSidebarRow[] {
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const childrenByParentId = new Map<string, ChatSidebarSessionInput[]>();
  for (const session of sessions) {
    const parentSessionId = session.parentSessionId?.trim();
    if (!parentSessionId || !sessionById.has(parentSessionId)) continue;
    const children = childrenByParentId.get(parentSessionId) ?? [];
    children.push(session);
    childrenByParentId.set(parentSessionId, children);
  }

  const activePathIds = new Set<string>();
  let activeCursor = activeSessionId?.trim() || null;
  while (activeCursor && !activePathIds.has(activeCursor)) {
    activePathIds.add(activeCursor);
    activeCursor = sessionById.get(activeCursor)?.parentSessionId?.trim() || null;
  }

  const rows: ChatSidebarRow[] = [];
  const emittedSessionIds = new Set<string>();
  const appendSession = (sessionId: string, depth: number, path: Set<string>) => {
    if (path.has(sessionId) || emittedSessionIds.has(sessionId)) return;
    const session = sessionById.get(sessionId);
    if (!session) return;
    emittedSessionIds.add(sessionId);
    rows.push({
      kind: 'session',
      key: `session:${session.sessionId}`,
      sessionId: session.sessionId,
      spaceId: session.spaceId,
      depth,
      activePath: activePathIds.has(session.sessionId),
    });
    const nextPath = new Set(path).add(sessionId);
    const children = childrenByParentId.get(sessionId) ?? [];
    const visibleChildren = collapsedForkParentIds.has(sessionId)
      ? children.filter((child) => activePathIds.has(child.sessionId))
      : children;
    for (const child of visibleChildren) appendSession(child.sessionId, depth + 1, nextPath);
  };

  for (const space of spaces) {
    if (includeSpaceRows) {
      rows.push({
        kind: 'space',
        key: `space:${space.spaceId}`,
        spaceId: space.spaceId,
        depth: 0,
      });
    }
    if (!space.expanded) continue;
    for (const sessionId of space.rootSessionIds) {
      appendSession(sessionId, 0, new Set());
    }
  }

  return rows;
}
