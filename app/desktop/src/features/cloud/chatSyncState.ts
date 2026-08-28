import type {
  ChatSyncBootstrapResponse,
  ChatSyncConversation,
  ChatSyncConversationInput,
  ChatSyncMessage,
} from './chatSyncTypes';

export type ChatSyncRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class ChatSyncState {
  readonly conversationBySessionId = new Map<string, ChatSyncConversation>();
  readonly conversationById = new Map<string, ChatSyncConversation>();
  readonly messageById = new Map<string, ChatSyncMessage>();
  bootstrap!: (token: string) => Promise<ChatSyncBootstrapResponse>;
  ensureConversation!: (
    token: string,
    input: ChatSyncConversationInput,
  ) => Promise<ChatSyncConversation>;

  constructor(
    readonly send: ChatSyncRequest,
    private readonly getAccountId: () => string | null,
    private readonly setAccountId: (value: string) => void,
    readonly errorStatus: (error: unknown) => number | null,
  ) {}

  get activeAccountId(): string | null {
    return this.getAccountId();
  }

  set activeAccountId(value: string | null) {
    if (value) this.setAccountId(value);
  }

  rememberConversation(conversation: ChatSyncConversation): void {
    const previous = this.conversationById.get(conversation.id);
    const previousSessionId = previous?.legacy_session_id?.trim();
    const sessionId = conversation.legacy_session_id?.trim();
    if (previousSessionId && previousSessionId !== sessionId) {
      this.conversationBySessionId.delete(previousSessionId);
    }
    this.conversationById.set(conversation.id, conversation);
    if (sessionId) this.conversationBySessionId.set(sessionId, conversation);
    const viewerAccountId = conversation.preferences.account_id?.trim();
    if (viewerAccountId) this.setAccountId(viewerAccountId);
  }

  forgetSession(sessionId: string): void {
    const normalized = sessionId.trim();
    const conversation = this.conversationBySessionId.get(normalized);
    this.conversationBySessionId.delete(normalized);
    if (conversation?.legacy_session_id?.trim() === normalized) {
      this.conversationById.delete(conversation.id);
    }
  }

  rememberBootstrap(response: ChatSyncBootstrapResponse): void {
    response.conversations.forEach((conversation) => this.rememberConversation(conversation));
    response.latest_messages.forEach((message) => this.messageById.set(message.id, message));
  }

  knownSessionIds(accountId: string): string[] {
    const viewerAccountId = accountId.trim();
    if (!viewerAccountId) return [];
    return [...this.conversationBySessionId.entries()]
      .filter(([, conversation]) => conversation.preferences.account_id === viewerAccountId)
      .map(([sessionId]) => sessionId);
  }
}
