import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import type { DesktopChatState } from '@/kordi-app/types';

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
