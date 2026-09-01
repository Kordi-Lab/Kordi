export type ChatSyncMember = {
  account_id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  default_agent_id?: string | null;
  default_agent_display_name?: string | null;
  default_agent_avatar_url?: string | null;
  role: string;
  membership_state: string;
  version: number;
  last_delivered_sequence: number;
  last_read_sequence: number;
  joined_at: string;
  left_at: string | null;
};

export type ChatSyncPreferences = {
  conversation_id: string;
  account_id: string;
  personal_title: string | null;
  version: number;
};

export type ChatSyncConversation = {
  id: string;
  kind: 'direct' | 'group' | 'ai';
  shared_title: string | null;
  version: number;
  created_by_account_id: string;
  legacy_session_id: string | null;
  group_space_id?: string | null;
  group_title?: string | null;
  forked_from_session_id?: string | null;
  forked_from_message_id?: string | null;
  latest_message_sequence: number;
  created_at: string;
  updated_at: string;
  members: ChatSyncMember[];
  preferences: ChatSyncPreferences;
};

export type ChatSyncMessage = {
  id: string;
  client_message_id: string;
  conversation_id: string;
  conversation_sequence: number;
  sender_account_id: string;
  kind: string;
  content: unknown;
  reply_to_message_id: string | null;
  attachment_ids: string[];
  version: number;
  generation_status: string | null;
  provider_response_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reactions?: Array<{ reaction: string; account_ids: string[] }>;
};

export type ChatSyncEvent = {
  stream_seq: number;
  event_id: string;
  protocol_version: 2;
  type: string;
  critical: boolean;
  conversation_id: string | null;
  entity_id: string | null;
  entity_version: number | null;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type CloudSessionPinAction = {
  kind: 'pinned' | 'unpinned';
  scope: 'private' | 'shared';
  messageId: string | null;
  updatedByAccountId: string | null;
  actorLabel?: string | null;
  updatedAt: string | null;
};

export type ChatSyncSyncResponse = {
  protocol_version: 2;
  events: ChatSyncEvent[];
  next_cursor: string;
  last_stream_seq: number;
  has_more: boolean;
  server_time: string;
};

export type ChatSyncBootstrapResponse = {
  protocol_version: 2;
  conversations: ChatSyncConversation[];
  latest_messages: ChatSyncMessage[];
  session_pins?: Array<{
    sessionId: string;
    sharedMessageId: string | null;
    privateMessageId: string | null;
    effectiveMessageId: string | null;
    updatedAt: string | null;
  }>;
  next_cursor: string;
  last_stream_seq: number;
  server_time: string;
};

export type ChatSyncConversationInput = {
  peerAccountId: string;
  sessionId?: string | null;
  kind?: ChatSyncConversation['kind'];
  memberAccountIds?: string[];
  sharedTitle?: string | null;
  accountId?: string | null;
  replaceMembers?: boolean;
};
