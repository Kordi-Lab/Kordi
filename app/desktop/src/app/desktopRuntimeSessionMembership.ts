import type { DesktopChatState } from '@/kordi-app/types';

/** True when the session is a desktop runtime session, either top-level or inside a project group. */
export function isDesktopRuntimeSessionId(
  sessions: DesktopChatState['sessions'] | undefined,
  projects: DesktopChatState['projects'] | undefined,
  sessionId: string,
): boolean {
  if (sessions?.some((session) => session.id === sessionId)) return true;
  return projects?.some((project) => (
    project.sessions.some((session) => session.id === sessionId)
  )) ?? false;
}
