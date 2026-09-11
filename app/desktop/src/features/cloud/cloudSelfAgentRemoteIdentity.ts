import type { CanonicalSessionState } from '@/kordi-app/types';
import type { ChatSyncMessageRef } from '@/lib/desktopChatSync';
import type { ChatSyncConversation, ChatSyncMessage } from './authClient';
import { canonicalHistoryMetadata } from './chatSyncMapping';
import {
  cloudSelfAgentOperationClientMessageId,
  type CloudSelfAgentSyncLedger,
  type CloudSelfAgentSyncOperation,
} from './cloudSelfAgentForwardSync';

type RemoteMessage = ChatSyncMessageRef | ChatSyncMessage;

// Reconcile durable identities before deriving a new upload ID from a local
// mirror. Text is deliberately not an identity: repeated sends must survive.
export function indexRemoteSelfAgentOperations({
  state, operations, conversations, messages, ledger,
}: {
  state: CanonicalSessionState;
  operations: readonly CloudSelfAgentSyncOperation[];
  conversations: readonly ChatSyncConversation[];
  messages: readonly RemoteMessage[];
  ledger: CloudSelfAgentSyncLedger;
}): Map<string, RemoteMessage> {
  const sessionByConversation = new Map(conversations.map((conversation) => [
    conversation.id, conversation.legacy_session_id ?? conversation.id,
  ]));
  const key = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);
  const byId = new Map<string, RemoteMessage>();
  const byClientId = new Map<string, RemoteMessage>();
  const byLocalId = new Map<string, RemoteMessage>();
  for (const message of messages) {
    const sessionId = sessionByConversation.get(message.conversation_id);
    if (!sessionId) continue;
    byId.set(key(sessionId, message.id), message);
    byClientId.set(key(sessionId, message.client_message_id), message);
    const history = 'content' in message ? canonicalHistoryMetadata(message.content) : null;
    if (history) byLocalId.set(key(sessionId, history.localMessageId), message);
  }
  const localById = new Map(state.messages.map((message) => [message.id, message]));
  const result = new Map<string, RemoteMessage>();
  for (const operation of operations) {
    const { sessionId, localMessageId } = operation;
    const clientId = cloudSelfAgentOperationClientMessageId(operation);
    const local = localById.get(localMessageId);
    const sourceId = local && (local.sourceTransport === 'cloud-self-agent' || local.id.startsWith('msg:cloud:self:'))
      ? local.sourceEventId
        || (local.id.startsWith('msg:cloud:self:') ? local.id.slice('msg:cloud:self:'.length) : '')
      : '';
    const ledgerId = ledger[localMessageId]?.cloudMessageId;
    const remote = byClientId.get(key(sessionId, clientId))
      ?? (sourceId ? byId.get(key(sessionId, sourceId)) : undefined)
      ?? (ledgerId ? byId.get(key(sessionId, ledgerId)) : undefined)
      ?? byLocalId.get(key(sessionId, localMessageId));
    if (remote) result.set(clientId, remote);
  }
  return result;
}
