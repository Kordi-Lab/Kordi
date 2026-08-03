import type { RefObject } from 'react';

import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { scrollTranscriptToBottom } from '@/features/chat/transcriptNavigation';
import type { Conversation } from '@/kordi-app/types';

export function scheduleTranscriptScrollToBottom<T extends HTMLElement>(
  scrollRef: RefObject<T | null>,
) {
  if (typeof window === 'undefined') return;
  const scheduleFrame =
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
  scheduleFrame(() => {
    scheduleFrame(() => scrollTranscriptToBottom(scrollRef));
  });
}

const GENERIC_CHAT_HEADER_SUBTITLES = new Set([
  'agent chat',
  'bridge',
  'chat',
  'cloud',
  'direct chat',
  'direct person chat',
  'person chat',
  'draft',
  'draft session',
  'external agent',
  'group',
  'group chat',
  'forked chat',
  'human',
  'local',
  'my agent',
  'owned',
  'person',
]);

export function isGenericChatHeaderSubtitle(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return (
    normalized.length === 0 || GENERIC_CHAT_HEADER_SUBTITLES.has(normalized)
  );
}

export function chatHeaderSubtitle(
  conversation: Pick<Conversation, 'subtitle'>,
): string | null {
  const formatted = formatSessionIdSubtitle(conversation.subtitle).trim();
  if (!formatted || isGenericChatHeaderSubtitle(formatted)) return null;
  return formatted;
}

export function shouldUseCompactModelRouteMenu(
  conversation: Pick<Conversation, 'type' | 'directness'>,
): boolean {
  const type = String(conversation.type ?? '').trim().toLowerCase();
  const directness = String(conversation.directness ?? '')
    .trim()
    .toLowerCase();
  return type === 'person' || type === 'group' || directness.includes('group');
}

export function localAgentComposerConfigTargetSessionId(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId'>,
): string | null {
  return (
    conversation.canonicalSessionId?.trim()
    || conversation.id.trim()
    || null
  );
}

export function selfAgentSessionIdForTitleRename(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'type'>,
): string | null {
  if (conversation.type !== 'owned-agent') return null;
  const sessionId =
    conversation.canonicalSessionId?.trim() || conversation.id.trim();
  if (
    !sessionId
    || sessionId === LOCAL_DRAFT_CHAT_CONVERSATION_ID
    || sessionId.startsWith('draft:')
    || isCloudAgentRuntimeSessionId(sessionId)
  ) {
    return null;
  }
  return sessionId;
}
