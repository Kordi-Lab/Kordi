import type {
  ChatSyncV2BootstrapResponse,
  ChatSyncV2Conversation,
  ChatSyncV2ConversationInput,
  ChatSyncV2Message,
} from './chatSyncV2Types';

export type ChatSyncV2Request = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class ChatSyncV2State {
  readonly conversationBySessionId = new Map<string, ChatSyncV2Conversation>();
  readonly conversationById = new Map<string, ChatSyncV2Conversation>();
  readonly messageById = new Map<string, ChatSyncV2Message>();
  bootstrap!: (token: string) => Promise<ChatSyncV2BootstrapResponse>;
  ensureConversation!: (
    token: string,
    input: ChatSyncV2ConversationInput,
  ) => Promise<ChatSyncV2Conversation>;

  constructor(
    readonly send: ChatSyncV2Request,
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

  rememberConversation(conversation: ChatSyncV2Conversation): void {
    this.conversationById.set(conversation.id, conversation);
    const sessionId = conversation.legacy_session_id?.trim();
    if (sessionId) this.conversationBySessionId.set(sessionId, conversation);
    const viewerAccountId = conversation.preferences.account_id?.trim();
    if (viewerAccountId) this.setAccountId(viewerAccountId);
  }

  rememberBootstrap(response: ChatSyncV2BootstrapResponse): void {
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
