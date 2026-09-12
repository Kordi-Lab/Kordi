import type { CanonicalMessagePage, CanonicalTimelineCursor } from '@/kordi-app/types';
import { beginChatPerformanceSpan, chatPerformancePayloadBytes, finishChatPerformanceSpan } from '@/features/performance/chatPerformance';
import { invokeDesktop, isNativeDesktopShell } from './desktop';

export async function fetchCanonicalSessionMessages(
  sessionId: string,
  beforeSequenceNum: number | null = null,
  limit = 100,
  timeline?: { before?: CanonicalTimelineCursor | null },
) {
  if (!isNativeDesktopShell()) return null;
  const performanceSpan = beginChatPerformanceSpan('canonical-page-ipc');
  try {
    const page = await invokeDesktop<CanonicalMessagePage>('desktop_canonical_session_messages', {
      sessionId,
      beforeSequenceNum,
      limit,
      ...(timeline ? { timelineOrder: true, beforeTimeline: timeline.before ?? null } : {}),
    });
    finishChatPerformanceSpan(performanceSpan, () => ({
      messageCount: page.messages.length,
      payloadBytes: chatPerformancePayloadBytes(page),
    }));
    return timeline ? { ...page, timelineOrder: true } : page;
  } catch (error) {
    finishChatPerformanceSpan(performanceSpan, { errorCount: 1 });
    throw error;
  }
}
