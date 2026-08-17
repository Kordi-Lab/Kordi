import type { CanonicalSessionMessage } from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import type {
  CloudSelfAgentCanonicalMessageIndex,
} from './cloudSelfAgentResponseLifecycle';
import {
  findExistingCanonicalCloudSelfAgentMessage,
} from './cloudSelfAgentResponseLifecycle';
import {
  cloudSelfAgentRequestClientMessageId,
  cloudSelfAgentResponseClientMessageId,
} from './cloudSelfAgentIdentity';

export type CloudSelfAgentMirrorReconciliation = {
  preferredMessageId: string;
  duplicateMessageId: string;
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function indexLocalSelfAgentMessagesByClientMessageId(
  messages: readonly CanonicalSessionMessage[],
): Map<string, CanonicalSessionMessage> {
  return new Map(messages.flatMap((candidate) => {
    const sourceTransport = candidate.sourceTransport ?? '';
    if (
      !cleanText(candidate.contentText)
      || !['desktop-chat-ui', 'desktop-chat'].includes(sourceTransport)
    ) return [];
    if (candidate.senderRole.includes('agent')) {
      const content = candidate.content && typeof candidate.content === 'object'
        && !Array.isArray(candidate.content)
        ? candidate.content as Record<string, unknown>
        : {};
      const localRequestMessageId = cleanText(candidate.parentMessageId)
        || cleanText(typeof content.replyToMessageId === 'string'
          ? content.replyToMessageId
          : null)
        || cleanText(typeof content.requestId === 'string'
          ? content.requestId
          : null);
      if (!localRequestMessageId) return [];
      return [[
        cloudSelfAgentResponseClientMessageId(
          candidate.sessionId,
          localRequestMessageId,
        ),
        candidate,
      ] as const];
    }
    if (candidate.senderRole !== 'user') return [];
    return [[
      cloudSelfAgentRequestClientMessageId(
        candidate.sessionId,
        candidate.id,
      ),
      candidate,
    ] as const];
  }));
}

export function resolveCloudSelfAgentMirror({
  message,
  sessionId,
  role,
  text,
  createdAtMs,
  stableCanonicalMessageId,
  existingCanonicalMessageIndex,
  localUserMessageByClientMessageId,
}: {
  message: CloudMessage;
  sessionId: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  createdAtMs: number;
  stableCanonicalMessageId: string;
  existingCanonicalMessageIndex: CloudSelfAgentCanonicalMessageIndex;
  localUserMessageByClientMessageId: ReadonlyMap<string, CanonicalSessionMessage>;
}): {
  existingMatch: CanonicalSessionMessage | null;
  reconciliation: CloudSelfAgentMirrorReconciliation | null;
} {
  const serverCanonicalMatch = findExistingCanonicalCloudSelfAgentMessage(
    existingCanonicalMessageIndex,
    {
      sessionId,
      role,
      text,
      createdAtMs,
      cloudMessageId: message.messageId,
      canonicalMessageId: stableCanonicalMessageId,
    },
  );
  const deterministicClientMatch = message.clientMessageId
    ? localUserMessageByClientMessageId.get(message.clientMessageId) ?? null
    : null;
  const exactLocalMatch = deterministicClientMatch
    && deterministicClientMatch.sessionId === sessionId
    && (
      role === 'user'
        ? deterministicClientMatch.senderRole === 'user'
        : role === 'system'
          ? deterministicClientMatch.senderRole === 'system'
          : deterministicClientMatch.senderRole.includes('agent')
    )
    && cleanText(deterministicClientMatch.contentText) === text
    ? deterministicClientMatch
    : null;
  const reconciliation = exactLocalMatch
    && serverCanonicalMatch
    && exactLocalMatch.id !== serverCanonicalMatch.id
    && serverCanonicalMatch.sourceTransport === 'cloud-self-agent'
    ? {
        preferredMessageId: exactLocalMatch.id,
        duplicateMessageId: serverCanonicalMatch.id,
      }
    : null;
  return {
    existingMatch: exactLocalMatch ?? serverCanonicalMatch,
    reconciliation,
  };
}
