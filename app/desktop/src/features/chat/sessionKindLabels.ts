import type { Conversation } from '@/kordi-app/types';

export const CHAT_KIND_LABELS = {
  agent: 'Agent chat',
  person: 'Person chat',
  group: 'Group chat',
  project: 'Project chat',
  fork: 'Forked chat',
  draft: 'Draft',
  unknown: 'Chat',
} as const;

export type ChatKindLabel = typeof CHAT_KIND_LABELS[keyof typeof CHAT_KIND_LABELS];

type ConversationKindSource = Partial<Pick<
  Conversation,
  'id' | 'canonicalSessionId' | 'type' | 'directness'
>>;

const LEGACY_LOCAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalSessionKindLabel(value?: string | null): ChatKindLabel | null {
  const sessionId = value?.trim().toLowerCase() ?? '';
  if (!sessionId) return null;
  if (sessionId === 'draft:local-chat' || sessionId.startsWith('draft:')) return CHAT_KIND_LABELS.draft;
  if (/^session:group(?::|-)/.test(sessionId)) return CHAT_KIND_LABELS.group;
  if (/^session:project(?::|-)/.test(sessionId) || sessionId.startsWith('project:')) return CHAT_KIND_LABELS.project;
  if (/^session:fork(?::|-)/.test(sessionId)) return CHAT_KIND_LABELS.fork;
  if (/^session:(?:self-agent|direct-agent)(?::|-)/.test(sessionId)) {
    return CHAT_KIND_LABELS.agent;
  }
  if (
    /^session:(?:direct-person|relationship)(?::|-)/.test(sessionId)
    || sessionId.startsWith('session:bridge:humans:')
  ) return CHAT_KIND_LABELS.person;
  if (sessionId.startsWith('session:bridge:agents:')) return CHAT_KIND_LABELS.agent;
  return null;
}

function legacyDescriptionKindLabel(value?: string | null): ChatKindLabel | null {
  const description = value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
  if (!description) return null;
  if (description === 'agent chat' || description === 'agent thread') return CHAT_KIND_LABELS.agent;
  if (['person chat', 'direct person chat', 'direct human chat', 'human chat'].includes(description)) {
    return CHAT_KIND_LABELS.person;
  }
  if (description === 'direct chat') return CHAT_KIND_LABELS.unknown;
  if (description === 'group' || description === 'group chat') return CHAT_KIND_LABELS.group;
  if (description === 'project' || description === 'project chat') return CHAT_KIND_LABELS.project;
  if (description === 'fork' || description === 'forked chat') return CHAT_KIND_LABELS.fork;
  if (description === 'draft' || description === 'draft session') return CHAT_KIND_LABELS.draft;
  return null;
}

export function chatKindDescriptionLabel(value?: string | null): ChatKindLabel | null {
  return legacyDescriptionKindLabel(value);
}

export function sessionIdChatKindLabel(value?: string | null): ChatKindLabel | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(/^session id:\s*/i, '');
  return canonicalSessionKindLabel(withoutPrefix)
    ?? (LEGACY_LOCAL_SESSION_ID.test(withoutPrefix) ? CHAT_KIND_LABELS.agent : null);
}

export function conversationChatKindLabel(conversation: ConversationKindSource): ChatKindLabel {
  const sessionId = conversation.canonicalSessionId?.trim() || conversation.id?.trim() || '';
  const canonicalLabel = canonicalSessionKindLabel(sessionId);
  if (canonicalLabel) return canonicalLabel;

  const conversationType = String(conversation.type ?? '').trim().toLowerCase();
  if (conversationType === 'group') return CHAT_KIND_LABELS.group;
  if (conversationType === 'person') return CHAT_KIND_LABELS.person;
  if (conversationType === 'owned-agent' || conversationType === 'external-agent') {
    return CHAT_KIND_LABELS.agent;
  }

  const descriptionLabel = legacyDescriptionKindLabel(conversation.directness);
  if (descriptionLabel) return descriptionLabel;
  if (LEGACY_LOCAL_SESSION_ID.test(sessionId)) return CHAT_KIND_LABELS.agent;
  return CHAT_KIND_LABELS.unknown;
}
