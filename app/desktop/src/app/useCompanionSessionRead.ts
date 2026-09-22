import { useEffect, useState } from 'react';
import { useCanonicalActiveSessionRead } from '@/features/cloud/useCanonicalActiveSessionRead';

type CompanionSessionReadOptions = Omit<
  Parameters<typeof useCanonicalActiveSessionRead>[0],
  'activeConversationId' | 'canMarkActiveConversationRead'
> & {
  enabled: boolean;
  localSessionUnreadCounts: Record<string, number>;
  clearUnreadForSession: (sessionId?: string | null) => void;
};

export function useCompanionSessionRead({
  enabled, localSessionUnreadCounts, clearUnreadForSession, ...canonical
}: CompanionSessionReadOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const canMarkRead = enabled && Boolean(sessionId);
  useCanonicalActiveSessionRead({
    ...canonical,
    activeConversationId: sessionId,
    canMarkActiveConversationRead: canMarkRead,
  });
  const localUnreadCount = sessionId ? localSessionUnreadCounts[sessionId] ?? 0 : 0;
  useEffect(() => {
    if (canMarkRead && localUnreadCount > 0) clearUnreadForSession(sessionId);
  }, [canMarkRead, sessionId, localUnreadCount, clearUnreadForSession]);
  return setSessionId;
}
