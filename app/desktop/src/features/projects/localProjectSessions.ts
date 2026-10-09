import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import type { ProjectSessionHint } from '@/features/canonical/sessionResolver';
import type { CanonicalSessionState, DesktopChatState } from '@/kordi-app/types';

export function localProjectSessions(desktopChatState: DesktopChatState) {
    const projectRootBySession = new Map((desktopChatState.projects ?? []).flatMap((project) =>
      project.sessions.map((session) => [session.id, project.root] as const)));
    const allLocalSessions = [...new Map([
      ...desktopChatState.sessions,
      ...(desktopChatState.projects ?? []).flatMap((project) => project.sessions),
    ].map((session) => [session.id, session])).values()];
    const activeSessionSummary = !isCloudAgentRuntimeSessionId(desktopChatState.activeSession.id)
      && !isLocalDraftChatConversationId(desktopChatState.activeSession.id)
      && !allLocalSessions.some((session) => session.id === desktopChatState.activeSession.id)
      ? {
          id: desktopChatState.activeSession.id,
          title: desktopChatState.activeSession.title || 'New session',
          subtitle: desktopChatState.activeSession.subtitle,
          updatedAtLabel: desktopChatState.activeSession.updatedAtLabel,
          updatedAtMs: desktopChatState.activeSession.updatedAtMs,
          messageCount: desktopChatState.activeSession.messageCount,
          draft: desktopChatState.activeSession.draft,
          forkedFromSessionId: desktopChatState.activeSession.forkedFromSessionId ?? null,
          forkedFromMessageId: desktopChatState.activeSession.forkedFromMessageId ?? null,
        }
      : null;
    const rawSessionSummaries = activeSessionSummary
      ? [activeSessionSummary, ...allLocalSessions]
      : allLocalSessions;
    const sessionSummaries = rawSessionSummaries.filter((session) => !isCloudAgentRuntimeSessionId(session.id));

    return { projectRootBySession, sessionSummaries };
}

/** Workspace bindings local sessions already carry before the project catalog lists them. */
export function localProjectSessionHints(
  desktopChatState: DesktopChatState,
  canonicalState?: CanonicalSessionState | null,
) {
  const { sessionSummaries } = localProjectSessions(desktopChatState);
  const activeSession = desktopChatState.activeSession;
  const defaultChatCwd = desktopChatState.cwd?.trim() ?? '';
  const activeCwd = activeSession.cwd?.trim() ?? '';
  // Leaving a project returns the session to the default chat workspace.
  const activeLeftProject = Boolean(defaultChatCwd) && activeCwd === defaultChatCwd;
  const sessionHints: ProjectSessionHint[] = sessionSummaries.map((session) => (
    session.id === activeSession.id
      ? {
          sessionId: session.id,
          paths: activeLeftProject ? [] : [activeSession.project?.root, activeCwd],
          updatedAtMs: session.updatedAtMs,
          rememberMembership: !activeLeftProject,
        }
      : { sessionId: session.id, updatedAtMs: session.updatedAtMs }
  ));
  // Canonical-only sessions carry no workspace yet; they can keep a remembered project.
  const localSessionIds = new Set(sessionSummaries.map((session) => session.id));
  for (const session of canonicalState?.sessions ?? []) {
    if (localSessionIds.has(session.id) || session.status === 'archived') continue;
    sessionHints.push({ sessionId: session.id, updatedAtMs: session.lastMessageAtMs ?? session.updatedAtMs });
  }
  // The runtime lists only plain chats here; project sessions never appear in it.
  const unboundSessionIds = new Set((desktopChatState.sessions ?? []).map((session) => session.id));
  return { sessionHints, unboundSessionIds, sessionSummaries };
}
