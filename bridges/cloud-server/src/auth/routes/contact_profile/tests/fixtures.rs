//! Rows the contact profile tests build directly: contacts, conversations,
//! messages, attachments, document shares, and Common ground cards.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

pub(super) async fn befriend(pool: &PgPool, left: &str, right: &str) {
    for (owner, peer) in [(left, right), (right, left)] {
        query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, '2026-08-12T09:30:00+00:00')",
        )
        .bind(owner)
        .bind(peer)
        .execute(pool)
        .await
        .unwrap();
    }
}

pub(super) async fn conversation(
    pool: &PgPool,
    kind: &str,
    session_id: &str,
    members: &[&str],
) -> Uuid {
    let id = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
         client_operation_id, creation_fingerprint, legacy_session_id, group_space_id, group_title) \
         VALUES ($1, $2, $3, $4, 'fixture', $5, $6, $7)",
    )
    .bind(id)
    .bind(kind)
    .bind(members[0])
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind((kind == "group").then_some(session_id))
    .bind((kind == "group").then(|| format!("Group {session_id}")))
    .execute(pool)
    .await
    .unwrap();
    for member in members {
        query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2)")
            .bind(id)
            .bind(member)
            .execute(pool)
            .await
            .unwrap();
    }
    id
}

pub(super) async fn message(
    pool: &PgPool,
    conversation: Uuid,
    sequence: i64,
    sender: &str,
    text: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_messages (message_id, conversation_id, conversation_sequence, \
         sender_account_id, client_message_id, request_fingerprint, content) \
         VALUES ($1, $2, $3, $4, $5, 'fixture', $6)",
    )
    .bind(id)
    .bind(conversation)
    .bind(sequence)
    .bind(sender)
    .bind(Uuid::new_v4())
    .bind(json!({"schema": 1, "blocks": [{"type": "text", "text": text}]}))
    .execute(pool)
    .await
    .unwrap();
    id
}

pub(super) async fn attach(pool: &PgPool, message: Uuid, owner: &str) -> String {
    let attachment = format!("att_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type, \
         size_bytes, created_at, finalized_at) VALUES ($1, $2, $1, 'text/markdown', 10, \
         '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
    )
    .bind(&attachment)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    query("INSERT INTO cloud_chat_message_attachments (message_id, attachment_id, position) VALUES ($1, $2, 0)")
        .bind(message)
        .bind(&attachment)
        .execute(pool)
        .await
        .unwrap();
    attachment
}

pub(super) async fn share(pool: &PgPool, attachment: &str, owner: &str, revoked: bool) {
    let id = format!("docshare_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_document_shares (share_id, token_hash, attachment_id, owner_account_id, \
         created_at, revoked_at) VALUES ($1, $1, $2, $3, '2026-10-01T00:00:00Z', $4)",
    )
    .bind(&id)
    .bind(attachment)
    .bind(owner)
    .bind(revoked.then_some("2026-10-02T00:00:00Z"))
    .execute(pool)
    .await
    .unwrap();
}

/// The account's work profile, created on first use.
pub(super) async fn work_profile(pool: &PgPool, account: &str) -> String {
    let existing: Option<(String,)> = query_as(
        "SELECT profile_id FROM cloud_common_ground_profiles \
         WHERE account_id = $1 AND kind = 'work'",
    )
    .bind(account)
    .fetch_optional(pool)
    .await
    .unwrap();
    if let Some((profile_id,)) = existing {
        return profile_id;
    }
    let profile_id = format!("cgp_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position) \
         VALUES ($1, $2, 'work', 'Work', 0)",
    )
    .bind(&profile_id)
    .bind(account)
    .execute(pool)
    .await
    .unwrap();
    profile_id
}

pub(super) async fn card(pool: &PgPool, account: &str, sharing: bool) {
    let profile_id = work_profile(pool, account).await;
    query(
        "INSERT INTO cloud_common_ground_cards (account_id, profile_id, topics_json, hidden_json, \
         sharing_enabled, built_at) VALUES ($1, $2, $3, '[\"Secret plan\"]', $4, now())",
    )
    .bind(account)
    .bind(&profile_id)
    .bind(json!({
        "workingOn": ["Tabletop manipulation", "Sim-to-real", "Secret plan", "Grasping", "Tactile", "Sixth"],
        "canHelp": ["Grant writing"],
        "lookingFor": ["Robot datasets"],
    }))
    .bind(sharing)
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn pair(pool: &PgPool, left: &str, right: &str) {
    let (a, b) = if left < right {
        (left, right)
    } else {
        (right, left)
    };
    let (profile_a, profile_b) = (work_profile(pool, a).await, work_profile(pool, b).await);
    query(
        "INSERT INTO cloud_common_ground_pairings (account_a, account_b, profile_a, profile_b) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(a)
    .bind(b)
    .bind(profile_a)
    .bind(profile_b)
    .execute(pool)
    .await
    .unwrap();
}
