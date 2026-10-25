import type { MessagePlanCard } from '@/kordi-app/types/message';
import type { CloudMessageAttachment, CloudVoiceMessage } from './cloudAttachmentTypes';

export type CloudMessageDirection = 'incoming' | 'outgoing';

export type CloudMessage = {
  messageId: string;
  fromAccountId: string;
  toAccountId: string;
  body: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  readByAccountIds?: string[];
  direction: CloudMessageDirection;
  sessionId?: string | null;
  attachments?: CloudMessageAttachment[]; voiceMessage?: CloudVoiceMessage | null;
  planCard?: MessagePlanCard | null;
  conversationId?: string | null;
  conversationSequence?: number | null;
  clientMessageId?: string | null;
  messageKind?: string | null;
  canonicalHistoryLocalMessageId?: string | null;
  version?: number | null; editedAt?: string | null; deletedAt?: string | null;
  reactions?: Array<{ value: string; accountIds: string[] }>; pendingReactionIntents?: Array<{ value: string; accountId: string; active: boolean }>;
};
