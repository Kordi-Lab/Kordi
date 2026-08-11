import type { CloudMessage, CloudSessionTitle, CloudSyncResponse, SendCloudMessageOptions, UpdateCloudSessionTitleInput } from './authClient';
import { ChatSyncV2ConversationClient } from './chatSyncV2ConversationClient';
import { ChatSyncV2State, type ChatSyncV2Request } from './chatSyncV2State';
import { ChatSyncV2SyncClient } from './chatSyncV2SyncClient';
import type { ChatSyncV2BootstrapResponse, ChatSyncV2Conversation, ChatSyncV2ConversationInput, ChatSyncV2Message } from './chatSyncV2Types';

export type ChatSyncV2ClientOptions = {
  request: ChatSyncV2Request;
  getActiveAccountId: () => string | null;
  setActiveAccountId: (value: string) => void;
  errorStatus: (error: unknown) => number | null;
};

export class ChatSyncV2Client {
  private readonly state: ChatSyncV2State;
  private readonly conversations: ChatSyncV2ConversationClient;
  private readonly sync: ChatSyncV2SyncClient;

  constructor(options: ChatSyncV2ClientOptions) {
    this.state = new ChatSyncV2State(
      options.request,
      options.getActiveAccountId,
      options.setActiveAccountId,
      options.errorStatus,
    );
    this.conversations = new ChatSyncV2ConversationClient(this.state);
    this.sync = new ChatSyncV2SyncClient(this.state);
    this.state.bootstrap = (token) => this.sync.bootstrapChatSyncV2(token);
    this.state.ensureConversation = (token, input) => (
      this.conversations.ensureChatV2Conversation(token, input)
    );
  }

  knownSessionIds(accountId: string): string[] {
    return this.state.knownSessionIds(accountId);
  }

  ensureConversation(token: string, input: ChatSyncV2ConversationInput): Promise<ChatSyncV2Conversation> {
    return this.conversations.ensureChatV2Conversation(token, input);
  }

  sendMessage(token: string, peerAccountId: string, body: string, options: SendCloudMessageOptions): Promise<CloudMessage> {
    return this.conversations.sendMessage(token, peerAccountId, body, options);
  }

  drainOutbox(token: string, accountId: string): Promise<CloudMessage[]> {
    return this.conversations.drainChatV2Outbox(token, accountId);
  }

  markMessagesRead(token: string, peerAccountId: string): Promise<void> {
    return this.conversations.markMessagesRead(token, peerAccountId);
  }

  markSessionMessagesRead(token: string, sessionId: string): Promise<void> {
    return this.conversations.markSessionMessagesRead(token, sessionId);
  }

  acknowledgeDelivery(token: string, conversationId: string, sequence: number): Promise<void> {
    return this.conversations.acknowledgeChatV2Delivery(token, conversationId, sequence);
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

  listHistoryPage(token: string, conversationId: string, beforeSequence?: number, limit = 200): Promise<{ messages: ChatSyncV2Message[]; nextBeforeSequence: number | null; hasMore: boolean }> {
    return this.sync.listChatV2ConversationHistoryPage(token, conversationId, beforeSequence, limit);
  }

  bootstrap(token: string): Promise<ChatSyncV2BootstrapResponse> {
    return this.sync.bootstrapChatSyncV2(token);
  }

  issueRealtimeTicket(token: string): Promise<{ ticket: string; device_id: string; expires_at: string }> {
    return this.sync.issueChatSyncV2RealtimeTicket(token);
  }
}
