import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { attachmentOnlyMessagePreview } from '@/features/chat/participantConversationState';
import { conversationChatKindLabel } from '@/features/chat/sessionKindLabels';
import { isGroupForkSession } from '@/features/chat/forkLineage';
import type { Conversation } from '@/kordi-app/types';
import type {
  WorkspaceSidebarConversation as ConversationItem,
  WorkspaceSidebarParticipantSpace as ParticipantSpaceItem,
} from '@/pages/workspaceSidebar.types';
import type { SessionContextMenuTarget } from '@/pages/SessionActionOverlays';

export function filterGroupForkSessionsFromSpaces(
  spaces: ParticipantSpaceItem[],
): ParticipantSpaceItem[] {
  return spaces
    .map((space) => ({
      ...space,
      sessions: space.sessions.filter((session) => !isGroupForkSession(session)),
    }))
    .filter((space) => space.sessions.length > 0);
}

export function participantSpaceSessionRowTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return '# Untitled session';
  return trimmed.startsWith('#') ? trimmed : `# ${trimmed}`;
}

export function participantSpaceSessionIdLabel(session: {
  id?: string | null;
  canonicalSessionId?: string | null;
  conversation?: Partial<
    Pick<Conversation, 'id' | 'canonicalSessionId' | 'type' | 'directness'>
  >;
}) {
  const sessionId = (session.id || session.canonicalSessionId || '').trim();
  if (!sessionId || sessionId === 'draft:local-chat' || sessionId.startsWith('draft:')) {
    return '';
  }
  if (session.conversation) {
    return conversationChatKindLabel({
      ...session.conversation,
      id: session.id ?? session.conversation.id,
      canonicalSessionId:
        session.canonicalSessionId ?? session.conversation.canonicalSessionId,
    });
  }
  return formatSessionIdSubtitle(sessionId);
}

export function participantSpaceSessionPreviewText(preview: string) {
  const formatted = formatSessionIdSubtitle(preview);
  if (/^session id:/i.test(formatted)) return '';
  return formatted;
}

export function participantSpaceSessionMessageCount(
  session: ParticipantSpaceItem['sessions'][number],
) {
  const canonicalCount = session.conversation.canonicalMessageCount;
  if (typeof canonicalCount === 'number' && Number.isFinite(canonicalCount)) {
    return Math.max(0, canonicalCount);
  }
  const visibleMessages = session.conversation.messages.filter(
    (message) => message.role !== 'system' && (
      message.text.trim().length > 0
      || (message.attachments?.length ?? 0) > 0
      || Boolean(message.turn?.assistantText.trim())
    ),
  ).length;
  return visibleMessages + (session.conversation.queuedMessages?.length ?? 0);
}

export function participantSpaceSessionPreviewLine(preview: string, messageCount: number) {
  const text = preview.trim() || 'No messages yet';
  return `${text} · ${messageCount} message${messageCount === 1 ? '' : 's'}`;
}

function sessionActionIdForConversation(conversation: ConversationItem) {
  const sessionId = (conversation.canonicalSessionId || conversation.id).trim();
  if (!sessionId || sessionId === 'draft:local-chat' || sessionId.startsWith('draft:')) {
    return null;
  }
  if (sessionId.startsWith('bridge:')) return null;
  return sessionId;
}

export function sessionContextMenuTargetForConversation(
  conversation: ConversationItem,
  x: number,
  y: number,
  options: { canRename?: boolean } = {},
): SessionContextMenuTarget | null {
  const sessionId = sessionActionIdForConversation(conversation);
  if (!sessionId) return null;

  return {
    sessionId,
    sessionName: conversation.name,
    x,
    y,
    ...(options.canRename === false ? { canRename: false } : {}),
  };
}

export function participantSpaceCanRenameSessions(space: ParticipantSpaceItem) {
  if (space.kind !== 'group') return true;
  const selfIdentityIds = new Set(
    space.participants
      .filter((participant) => participant.role === 'self' || participant.source === 'local')
      .map((participant) => participant.id.trim())
      .filter(Boolean),
  );
  if (selfIdentityIds.size === 0) return false;
  const adminIdentityIds = new Set(
    (space.groupAdminIdentityIds ?? [])
      .map((identityId) => identityId.trim())
      .filter(Boolean),
  );
  return [...selfIdentityIds].some((identityId) => adminIdentityIds.has(identityId));
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function participantSpaceKindText(space: ParticipantSpaceItem) {
  if (space.kind === 'self') return 'Personal';
  if (space.kind === 'direct-human') return 'Person';
  if (space.kind === 'direct-agent') return 'Agent';
  return 'Group';
}

export function participantSpaceDetailText(space: ParticipantSpaceItem) {
  const sessionText = pluralize(space.sessionCount, 'session');
  if (space.kind === 'self') return `Personal • ${sessionText}`;
  if (space.kind === 'direct-human') return null;
  if (space.kind === 'group') {
    const humanCount = space.participants.filter(
      (participant) => participant.kind === 'human',
    ).length;
    const peopleText =
      humanCount > 0 ? `${pluralize(humanCount, 'person', 'people')} • ` : '';
    return `Group • ${peopleText}${sessionText}`;
  }
  return `Agent • ${sessionText}`;
}

export function participantSpacePreviewAttachment(
  space: ParticipantSpaceItem,
) {
  const messages = space.sessions[0]?.conversation.messages ?? [];
  const latestMessage = messages[messages.length - 1];
  const preview = attachmentOnlyMessagePreview(latestMessage);
  if (!preview) return null;
  const attachments = latestMessage?.attachments ?? [];
  const attachment = preview.kind === 'image'
    ? attachments.find((candidate) => (
      candidate.kind === 'image'
      || candidate.mimeType?.toLowerCase().startsWith('image/')
    ))
    : attachments[0];
  return attachment ? { attachment, kind: preview.kind } : null;
}
