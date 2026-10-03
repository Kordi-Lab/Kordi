import { cloudMessageDeletions, type CloudMessageDeletions } from './cloudMessageDeletions';
import { noteContentRemovalAccount, setServerContentRemovalVersion } from './contentRemovalCapability';
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
    readonly deletions: CloudMessageDeletions = cloudMessageDeletions,
  ) {}

  get activeAccountId(): string | null {
    const accountId = this.getAccountId();
    // The account can change outside this state (sign-in), so the first chat
    // operation for a new account forgets the previous server capability.
    if (accountId) noteContentRemovalAccount(accountId);
    return accountId;
  }

  set activeAccountId(value: string | null) {
    if (value) this.adoptAccount(value);
  }

  private adoptAccount(accountId: string): void {
    noteContentRemovalAccount(accountId);
    this.setAccountId(accountId);
  }

  /** Records the server's content removal version for the account that asked. */
  recordContentRemovalVersion(value: unknown, accountId = this.activeAccountId): void {
    const activeAccountId = this.activeAccountId;
    if (accountId && activeAccountId && accountId !== activeAccountId) return;
    setServerContentRemovalVersion(value ?? 0, activeAccountId ?? accountId);
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
    if (viewerAccountId) this.adoptAccount(viewerAccountId);
  }

  forgetSession(sessionId: string): void {
    const normalized = sessionId.trim();
    const conversation = this.conversationBySessionId.get(normalized);
    this.conversationBySessionId.delete(normalized);
    if (conversation?.legacy_session_id?.trim() === normalized) {
      this.conversationById.delete(conversation.id);
    }
  }

  removeMessage(messageId: string, accountId = this.activeAccountId): void {
    this.deletions.remember(accountId, [messageId]);
    if (accountId === this.activeAccountId) this.messageById.delete(messageId);
  }

  retainMessages(messages: ChatSyncMessage[], accountId = this.activeAccountId): ChatSyncMessage[] {
    const kept = messages.filter((message) => {
      if (message.deleted_at) {
        this.removeMessage(message.id, accountId);
        return false;
      }
      return !this.deletions.ids(accountId).has(message.id);
    });
    if (accountId === this.activeAccountId) {
      kept.forEach((message) => this.messageById.set(message.id, message));
    }
    return kept;
  }

  rememberBootstrap(response: ChatSyncBootstrapResponse): void {
    response.conversations.forEach((conversation) => this.rememberConversation(conversation));
    this.retainMessages(response.latest_messages);
  }

  knownSessionIds(accountId: string): string[] {
    const viewerAccountId = accountId.trim();
    if (!viewerAccountId) return [];
    return [...this.conversationBySessionId.entries()]
      .filter(([, conversation]) => conversation.preferences.account_id === viewerAccountId)
      .map(([sessionId]) => sessionId);
  }
}
