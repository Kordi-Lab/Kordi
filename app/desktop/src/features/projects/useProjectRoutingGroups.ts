import { useMemo, useState } from 'react';
import {
  buildProjectRoutingGroups,
  rememberProjectMembership,
} from '@/features/canonical/sessionResolver';
import type { CanonicalSessionState, DesktopChatState } from '@/kordi-app/types';
import { localProjectSessionHints } from './localProjectSessions';

function sameMembership(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  if (left.size !== right.size) return false;
  for (const [sessionId, groupId] of left) {
    if (right.get(sessionId) !== groupId) return false;
  }
  return true;
}

/**
 * Project groups for the sidebar and project views. A session whose project is
 * already known stays in its group while the runtime catalog catches up.
 */
export function useProjectRoutingGroups(
  desktopChatState: DesktopChatState | null | undefined,
  canonicalSessionState: CanonicalSessionState | null | undefined,
) {
  const [membership, setMembership] = useState<ReadonlyMap<string, string>>(() => new Map());
  const hints = useMemo(
    () => (desktopChatState ? localProjectSessionHints(desktopChatState, canonicalSessionState) : null),
    [canonicalSessionState, desktopChatState],
  );
  const groups = useMemo(() => buildProjectRoutingGroups(desktopChatState?.projects, canonicalSessionState, {
    sessionHints: hints?.sessionHints,
    unboundSessionIds: hints?.unboundSessionIds,
    previousGroupIdBySession: membership,
  }), [canonicalSessionState, desktopChatState?.projects, hints, membership]);
  const nextMembership = useMemo(
    () => rememberProjectMembership(membership, groups, hints?.unboundSessionIds),
    [groups, hints, membership],
  );
  if (!sameMembership(nextMembership, membership)) setMembership(nextMembership);
  const sessionSummaryById = useMemo(
    () => new Map((hints?.sessionSummaries ?? []).map((session) => [session.id, session])),
    [hints],
  );
  return useMemo(() => ({ groups, sessionSummaryById }), [groups, sessionSummaryById]);
}
