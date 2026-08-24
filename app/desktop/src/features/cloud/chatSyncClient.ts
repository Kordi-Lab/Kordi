import type { CloudMessage, CloudSessionTitle, CloudSyncResponse, SendCloudMessageOptions, UpdateCloudSessionTitleInput } from './authClient';
import { ChatSyncConversationClient } from './chatSyncConversationClient';
import { ChatSyncState, type ChatSyncRequest } from './chatSyncState';
import { ChatSyncSyncClient } from './chatSyncSyncClient';
import type { ChatSyncBootstrapResponse, ChatSyncConversation, ChatSyncConversationInput, ChatSyncMessage } from './chatSyncTypes';

export type ChatSyncClientOptions = {
  request: ChatSyncRequest;
  getActiveAccountId: () => string | null;
  setActiveAccountId: (value: string) => void;
  errorStatus: (error: unknown) => number | null;
};

export class ChatSyncClient {
  private readonly state: ChatSyncState;
  private readonly conversations: ChatSyncConversationClient;
  private readonly sync: ChatSyncSyncClient;

  constructor(options: ChatSyncClientOptions) {
    this.state = new ChatSyncState(
      options.request,
      options.getActiveAccountId,
      options.setActiveAccountId,
      options.errorStatus,
    );
    this.conversations = new ChatSyncConversationClient(this.state);
    this.sync = new ChatSyncSyncClient(this.state);
    this.state.bootstrap = (token) => this.sync.bootstrapChatSync(token);
    this.state.ensureConversation = (token, input) => (
      this.conversations.ensureChatConversation(token, input)
    );
  }

  knownSessionIds(accountId: string): string[] {
    return this.state.knownSessionIds(accountId);
  }

  ensureConversation(token: string, input: ChatSyncConversationInput): Promise<ChatSyncConversation> {
    return this.conversations.ensureChatConversation(token, input);
  }

  sendMessage(token: string, peerAccountId: string, body: string, options: SendCloudMessageOptions): Promise<CloudMessage> {
    return this.conversations.sendMessage(token, peerAccountId, body, options);
  }

  drainOutbox(token: string, accountId: string): Promise<CloudMessage[]> {
    return this.conversations.drainChatOutbox(token, accountId);
  }

  setReaction(token: string, conversationId: string, messageId: string, reaction: string, active: boolean): Promise<CloudMessage> {
    return this.conversations.setReaction(token, conversationId, messageId, reaction, active);
  }

  markMessagesRead(token: string, peerAccountId: string): Promise<void> {
    return this.conversations.markMessagesRead(token, peerAccountId);
  }

  markSessionMessagesRead(token: string, sessionId: string): Promise<void> {
    return this.conversations.markSessionMessagesRead(token, sessionId);
  }

  acknowledgeDelivery(token: string, conversationId: string, sequence: number): Promise<void> {
    return this.conversations.acknowledgeChatDelivery(token, conversationId, sequence);
  }

  updateTitle(token: string, sessionId: string, input: UpdateCloudSessionTitleInput): Promise<CloudSessionTitle> {
    return this.conversations.updateCloudSessionTitle(token, sessionId, input);
  }

  syncEvents(token: string, cursor: string, limit?: number): Promise<CloudSyncResponse> {
    return this.sync.syncCloudEvents(token, cursor, limit);
  }

  listMessageSnapshot(token: string, peerAccountId: string, limit?: number, viewerAccountId?: string | null) {
    return this.sync.listMessageSnapshot(token, peerAccountId, limit, viewerAccountId);
  }

  listHistoryPage(token: string, conversationId: string, beforeSequence?: number, limit = 200): Promise<{ messages: ChatSyncMessage[]; nextBeforeSequence: number | null; hasMore: boolean }> {
    return this.sync.listChatConversationHistoryPage(token, conversationId, beforeSequence, limit);
  }

  bootstrap(token: string): Promise<ChatSyncBootstrapResponse> {
    return this.sync.bootstrapChatSync(token);
  }

  issueRealtimeTicket(token: string): Promise<{ ticket: string; device_id: string; expires_at: string }> {
    return this.sync.issueChatSyncRealtimeTicket(token);
  }
}
