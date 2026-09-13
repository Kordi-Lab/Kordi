import type { CanonicalSessionState } from '@/kordi-app/types';
import { loadChatSyncMessagesPage } from '@/lib/desktopChatSync';
import type { CloudAuthClient } from './authClient';
import type { ChatSyncConversation, ChatSyncMessage } from './chatSyncTypes';
import { selfAgentMessageAttachments, uploadSelfAgentMessageAttachments } from './cloudSelfAgentAttachments';
import { cloudSelfAgentOperationClientMessageId } from './cloudSelfAgentForwardSync';
import { loadCloudSelfAgentSyncLedger, saveCloudSelfAgentSyncLedger } from './cloudSelfAgentSyncLedger';

const completed = new Set<string>();

export function missingImageCandidate(message: ChatSyncMessage, localId: string) {
  if (message.kind !== 'canonical-history-user' || message.deleted_at || message.edited_at
    || message.version !== 1 || message.attachment_ids.length) return false;
  const content = (message.content && typeof message.content === 'object' ? message.content : {}) as { canonical_history?: { local_message_id?: string; localMessageId?: string } };
  return (content.canonical_history?.local_message_id ?? content.canonical_history?.localMessageId) === localId;
}

/** Repair only loaded, provable local history exports. Never scan unrelated sessions or infer missing files. */
export async function backfillLocalHistoryImages({
  accountId, token, state, conversations, client, shouldContinue,
  loadPage = loadChatSyncMessagesPage, upload = uploadSelfAgentMessageAttachments,
}: {
  accountId: string; token: string; state: CanonicalSessionState; conversations: ChatSyncConversation[];
  client: CloudAuthClient; shouldContinue: () => boolean;
  loadPage?: typeof loadChatSyncMessagesPage; upload?: typeof uploadSelfAgentMessageAttachments;
}) {
  let repaired = false;
  const ledger = loadCloudSelfAgentSyncLedger(accountId);
  for (const conversation of conversations) {
    if (!shouldContinue()) return repaired;
    if (conversation.kind !== 'ai') continue;
    const sessionId = conversation.legacy_session_id ?? conversation.id;
    const candidates = state.messages.filter(message => message.sessionId === sessionId && message.senderRole === 'user')
      .map(message => ({ message, attachments: selfAgentMessageAttachments(message.content) }))
      .filter(({ attachments }) => attachments.length && attachments.every(a => a.kind === 'image' && !!a.path && !a.attachmentId));
    if (!candidates.length) continue;
    let after = 0;
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      const page = await loadPage(accountId, conversation.id, after, 100);
      if (!page || !shouldContinue()) break;
      for (const { message: local, attachments } of candidates) {
        const operation = { localMessageId: local.id, sessionId, role: 'user' as const, text: local.contentText,
          parentLocalMessageId: null, createdAtMs: local.createdAtMs, deliveryState: 'sent' as const, attachments };
        const wire = page.messages.find(message => missingImageCandidate(message, local.id)
          && message.client_message_id === cloudSelfAgentOperationClientMessageId(operation));
        if (!wire) continue;
        const key = `${accountId}:${wire.id}`;
        if (completed.has(key)) continue;
        try {
          const uploadKey = `image-backfill:${local.id}`;
          const images = ledger[uploadKey]?.uploadedAttachments ?? await upload(operation, client, token, accountId);
          if (!shouldContinue()) return repaired;
          ledger[uploadKey] = { cloudMessageId: null, syncedAtMs: Date.now(), uploadedAttachments: images };
          saveCloudSelfAgentSyncLedger(accountId, ledger);
          await client.chat.backfillMissingImages(token, conversation.id, wire.id,
            images.map(image => ({ attachmentId: image.attachmentId, name: image.name })));
          completed.add(key); repaired = true;
        } catch {
          // A concurrent edit/delete can make this exact repair ineligible.
          // Preserve the message and let ordinary sync refresh its snapshot.
        }
      }
      if (!page.hasMore || page.nextAfterSequence == null || page.nextAfterSequence <= after) break;
      after = page.nextAfterSequence;
    }
  }
  return repaired;
}
