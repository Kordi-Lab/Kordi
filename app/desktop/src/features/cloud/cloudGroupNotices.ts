import type { AppendCanonicalMessageRequest, CanonicalSessionMessage } from '@/kordi-app/types';
import { cloudGroupNonGenericTitle, cloudSessionTitleUpdateTitle, type CloudGroupControlEnvelope } from './cloudGroupMessages';

function cleanText(value?: string | null) { return value?.trim() ?? ''; }

function cloudTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  actorDisplayName?: string | null;
  createdAtMs: number;
  cloudMessageId: string;
  scope: 'group' | 'session';
  title: string | null;
}): AppendCanonicalMessageRequest | null {
  const title = cloudGroupNonGenericTitle(input.title);
  const actorIdentityId = cleanText(input.actorIdentityId);
  if (!title || !actorIdentityId) return null;
  const actorDisplayName = cleanText(input.actorDisplayName ?? input.envelope.actor.displayName) || 'Someone';
  const cloudMessageId = cleanText(input.cloudMessageId) || `${input.envelope.groupId}:${input.createdAtMs}`;
  const noticeKind = input.scope === 'group' ? 'group-title-update' : 'session-title-update';
  const transport = input.scope === 'group' ? 'cloud-group-title-update' : 'cloud-group-session-title-update';
  const scopeLabel = input.scope === 'group' ? 'group' : 'channel';
  return {
    id: `cloud-${input.scope}-title-notice:${cloudMessageId}`,
    sessionId: input.envelope.groupId,
    senderIdentityId: actorIdentityId,
    senderRole: 'system',
    messageKind: 'status',
    contentText: `${actorDisplayName} changed the ${scopeLabel} name to ${title}`,
    content: {
      kind: noticeKind,
      scope: input.scope,
      title,
      actorDisplayName,
      ...(input.scope === 'group' ? { sourceControlKind: 'group-title-update' } : {}),
    },
    createdAtMs: input.createdAtMs,
    status: 'complete',
    sourceTransport: transport,
    sourceEventId: `${transport}:${cloudMessageId}`,
  };
}

export function cloudGroupTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  createdAtMs: number;
  cloudMessageId: string;
}): AppendCanonicalMessageRequest | null {
  return cloudTitleUpdateNoticeRequest({
    ...input,
    scope: 'group',
    title: input.envelope.kind === 'group-title-update' && cloudGroupNonGenericTitle(input.envelope.groupTitle) ? input.envelope.groupTitle : null,
  });
}

export function cloudTitleUpdateNoticeEquivalent(
  existing: Pick<CanonicalSessionMessage, 'sessionId' | 'senderIdentityId' | 'content' | 'createdAtMs'>,
  incoming: AppendCanonicalMessageRequest,
) {
  if (
    existing.sessionId !== incoming.sessionId
    || existing.senderIdentityId !== incoming.senderIdentityId
    || incoming.createdAtMs == null
    || Math.abs(existing.createdAtMs - incoming.createdAtMs) > 10_000
  ) return false;
  const existingContent = existing.content && typeof existing.content === 'object' && !Array.isArray(existing.content)
    ? existing.content as Record<string, unknown>
    : {};
  const incomingContent = incoming.content && typeof incoming.content === 'object' && !Array.isArray(incoming.content)
    ? incoming.content as Record<string, unknown>
    : {};
  return existingContent.kind === incomingContent.kind
    && existingContent.scope === incomingContent.scope
    && existingContent.title === incomingContent.title;
}

export function cloudSessionTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  actorDisplayName?: string | null;
  createdAtMs: number;
  cloudMessageId: string;
}): AppendCanonicalMessageRequest | null {
  if (input.envelope.kind === 'group-invite' && input.envelope.channelCreated === true) {
    const id = `channel-created:${input.envelope.groupId}`;
    return {
      id, sessionId: input.envelope.groupId, senderIdentityId: input.actorIdentityId,
      senderRole: 'system', messageKind: 'status',
      contentText: `${input.envelope.actor.displayName.trim() || 'Someone'} created this channel.`,
      content: { kind: 'channel-created' }, createdAtMs: input.createdAtMs, status: 'complete',
      sourceTransport: 'cloud-group-channel-created', sourceEventId: id,
    };
  }
  if (input.envelope.sessionTitleSyncOnly) return null;
  return cloudTitleUpdateNoticeRequest({
    ...input,
    scope: 'session',
    title: cloudSessionTitleUpdateTitle(input.envelope),
  });
}
