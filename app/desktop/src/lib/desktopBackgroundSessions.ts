import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { invokeDesktop } from '@/lib/desktop';
import type {
  DesktopChatContextMessage,
  DesktopChatMessageRoute,
  DesktopVisibleTaskRecord,
} from '@/lib/desktop';

export function desktopSharedRequestAlreadyStarted(error: unknown) {
  return String(error).includes('shared_request_already_started');
}

export function startDesktopSharedChatMessage(
  requestId: string,
  sessionId: string,
  text: string,
  attachmentPaths: string[] = [],
  route?: DesktopChatMessageRoute | null,
  contextMessages: DesktopChatContextMessage[] = [],
  visibleTaskRecords: DesktopVisibleTaskRecord[] = [],
  scheduledTaskSessionId: string | null = null,
  executionLeaseDeadlineMs: number | null = null,
  /** Where a background follow-up of this request publishes its reply. */
  backgroundFollowUpRoute: unknown = null,
) {
  return invokeDesktop<DesktopChatTurnSnapshot>('desktop_chat_start_shared_message', {
    requestId,
    sessionId,
    text,
    attachmentPaths,
    route: route ?? null,
    contextMessages,
    visibleTaskRecords,
    scheduledTaskSessionId,
    executionLeaseDeadlineMs,
    backgroundFollowUpRoute,
  });
}

export function markDesktopBackgroundFollowUpPublished(turnId: string) {
  return invokeDesktop<boolean>('desktop_chat_mark_background_follow_up_published', { turnId });
}

export function fetchDesktopSubsessionIds() {
  return invokeDesktop<string[]>('desktop_chat_subsession_ids');
}

export function fetchDesktopSubsessionSnapshot(sessionId: string) {
  return invokeDesktop<import('@/features/cloud/agentSubsessionTypes').NativeAgentSubsession>('desktop_chat_subsession_snapshot', { sessionId });
}

export function fetchDesktopChatActiveTurns() {
  return invokeDesktop<DesktopChatTurnSnapshot[]>('desktop_chat_active_turns');
}
