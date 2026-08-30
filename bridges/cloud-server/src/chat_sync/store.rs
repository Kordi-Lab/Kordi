use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::chat_sync::models::{
    AddConversationMembersRequest, AdvanceConversationCursorRequest, CloudSessionPinSummary,
    ConversationCursorSnapshot, ConversationKind, ConversationPreferencesSnapshot,
    ConversationSnapshot, CreateConversationRequest, HistoryResponse, MemberSnapshot,
    MessageSnapshot, ReactionSnapshot, SendMessageRequest, SyncEventSnapshot,
    UpdateConversationTitleRequest, UpdateMessageRequest, UpdatePersonalTitleRequest,
};
use crate::chat_sync::PROTOCOL_VERSION;

const MAX_GROUP_MEMBERS: usize = 100;
const MAX_HISTORY_LIMIT: i64 = 200;
const DEFAULT_HISTORY_LIMIT: i64 = 50;
const MAX_SYNC_LIMIT: i64 = 1_000;
const DEFAULT_SYNC_LIMIT: i64 = 500;
const MAX_SYNC_BATCH_BYTES: usize = 1_048_576;

#[derive(Debug)]
pub enum StoreError {
    Database(sqlx_core::Error),
    InvalidInput(&'static str),
    NotFound,
    Forbidden,
    IdempotencyKeyReused,
    VersionConflict(Box<ConversationSnapshot>),
    PreferencesVersionConflict(Box<ConversationPreferencesSnapshot>),
    MessageVersionConflict(Box<MessageSnapshot>),
    CursorExpired,
    CursorAhead,
    InvariantViolation(&'static str),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "database error: {error}"),
            Self::InvalidInput(message) | Self::InvariantViolation(message) => {
                formatter.write_str(message)
            }
            Self::NotFound => formatter.write_str("conversation or message not found"),
            Self::Forbidden => formatter.write_str("operation is not authorized"),
            Self::IdempotencyKeyReused => {
                formatter.write_str("client operation id was reused with different input")
            }
            Self::VersionConflict(_) => formatter.write_str("conversation version conflict"),
            Self::PreferencesVersionConflict(_) => {
                formatter.write_str("conversation preferences version conflict")
            }
            Self::MessageVersionConflict(_) => formatter.write_str("message version conflict"),
            Self::CursorExpired => formatter.write_str("sync cursor expired"),
            Self::CursorAhead => formatter.write_str("sync cursor is ahead of the server"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<sqlx_core::Error> for StoreError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

pub struct InsertOutcome<T> {
    pub value: T,
    pub inserted: bool,
}

pub struct SyncBatch {
    pub events: Vec<SyncEventSnapshot>,
    pub next_stream_seq: i64,
    pub has_more: bool,
}

pub struct BootstrapSnapshot {
    pub conversations: Vec<ConversationSnapshot>,
    pub latest_messages: Vec<MessageSnapshot>,
    pub session_pins: Vec<CloudSessionPinSummary>,
    pub stream_seq: i64,
    pub server_time: DateTime<Utc>,
}

#[derive(Serialize)]
struct CreationIntent<'a> {
    kind: ConversationKind,
    shared_title: &'a Option<String>,
    client_session_id: &'a str,
    member_account_ids: &'a [String],
}

#[derive(Serialize)]
struct MessageIntent<'a> {
    conversation_id: Uuid,
    kind: &'a str,
    content: &'a Value,
    reply_to_message_id: Option<Uuid>,
    attachment_ids: &'a [String],
}

#[derive(Serialize)]
struct SharedTitleIntent<'a> {
    conversation_id: Uuid,
    expected_version: i32,
    shared_title: &'a Option<String>,
}

#[derive(Serialize)]
struct PersonalTitleIntent<'a> {
    conversation_id: Uuid,
    expected_preferences_version: i32,
    personal_title: &'a Option<String>,
}

#[derive(Serialize)]
struct CursorIntent {
    conversation_id: Uuid,
    sequence: i64,
}

#[derive(Serialize)]
struct AddMembersIntent<'a> {
    conversation_id: Uuid,
    member_account_ids: &'a [String],
    replace: bool,
}

type ConversationRow = (
    Uuid,
    String,
    Option<String>,
    i32,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    DateTime<Utc>,
    DateTime<Utc>,
);

type MemberRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    i32,
    i64,
    i64,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

type MessageRow = (
    Uuid,
    Uuid,
    Uuid,
    i64,
    String,
    String,
    Value,
    Option<Uuid>,
    i32,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
);

type SyncEventRow = (
    i64,
    Uuid,
    i32,
    String,
    bool,
    Option<Uuid>,
    Option<Uuid>,
    Option<i32>,
    DateTime<Utc>,
    Value,
);

mod conversation;
mod cursors;
mod members;
mod meme_validation;
mod message;
mod pin_snapshots;
mod reaction;
mod support;
mod sync_events;
mod titles;

pub(crate) use conversation::create_conversation_in_transaction;
pub use conversation::{create_conversation, create_conversation_with_trusted_peer};
pub use cursors::{advance_delivery_cursor, advance_read_cursor, bootstrap, history, sync_batch};
pub use members::{accept_invited_conversation_member, add_conversation_members};
pub use message::{
    conversation_id_for_session, delete_message, edit_message, load_message_snapshot,
    replace_message_snapshot, send_message,
};
pub(crate) use message::{replace_server_message_in_transaction, send_message_in_transaction};
use reaction::reactions_by_message;
pub use reaction::set_reaction;
pub use support::{
    append_user_sync_events_in_transaction, identity_sync_recipient_ids, publish_user_sync_events,
};
use sync_events::{insert_noncritical_sync_event, insert_sync_event};
pub use titles::{update_personal_title, update_shared_title};
