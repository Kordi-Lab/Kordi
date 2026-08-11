export type ChatSyncV2Member = {
  account_id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  role: string;
  membership_state: string;
  version: number;
  last_delivered_sequence: number;
  last_read_sequence: number;
  joined_at: string;
  left_at: string | null;
};

export type ChatSyncV2Preferences = {
  conversation_id: string;
  account_id: string;
  personal_title: string | null;
  version: number;
};

export type ChatSyncV2Conversation = {
  id: string;
  kind: 'direct' | 'group' | 'ai';
  shared_title: string | null;
  version: number;
  created_by_account_id: string;
  legacy_session_id: string | null;
  forked_from_session_id?: string | null;
  forked_from_message_id?: string | null;
  latest_message_sequence: number;
  created_at: string;
  updated_at: string;
  members: ChatSyncV2Member[];
  preferences: ChatSyncV2Preferences;
};

export type ChatSyncV2Message = {
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
};

export type ChatSyncV2Event = {
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

export type ChatSyncV2SyncResponse = {
  protocol_version: 2;
  events: ChatSyncV2Event[];
  next_cursor: string;
  last_stream_seq: number;
  has_more: boolean;
  server_time: string;
};

export type ChatSyncV2BootstrapResponse = {
  protocol_version: 2;
  conversations: ChatSyncV2Conversation[];
  latest_messages: ChatSyncV2Message[];
  next_cursor: string;
  last_stream_seq: number;
  server_time: string;
};

export type ChatSyncV2ConversationInput = {
  peerAccountId: string;
  sessionId?: string | null;
  kind?: ChatSyncV2Conversation['kind'];
  memberAccountIds?: string[];
  sharedTitle?: string | null;
  accountId?: string | null;
  replaceMembers?: boolean;
};
