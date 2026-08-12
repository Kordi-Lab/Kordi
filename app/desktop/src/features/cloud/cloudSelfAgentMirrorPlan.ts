import type { CanonicalSessionMessage } from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import type {
  CloudSelfAgentCanonicalMessageIndex,
} from './cloudSelfAgentResponseLifecycle';
import {
  findExistingCanonicalCloudSelfAgentMessage,
} from './cloudSelfAgentResponseLifecycle';
import { cloudSelfAgentRequestClientMessageId } from './cloudSelfAgentV2Identity';

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
    if (
      candidate.senderRole !== 'user'
      || !cleanText(candidate.contentText)
      || !['desktop-chat-ui', 'desktop-chat'].includes(
        candidate.sourceTransport ?? '',
      )
    ) return [];
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
  role: 'user' | 'agent';
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
  const deterministicClientMatch = role === 'user'
    && message.clientMessageId
    ? localUserMessageByClientMessageId.get(message.clientMessageId) ?? null
    : null;
  const exactLocalMatch = deterministicClientMatch
    && deterministicClientMatch.sessionId === sessionId
    && deterministicClientMatch.senderRole === 'user'
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
