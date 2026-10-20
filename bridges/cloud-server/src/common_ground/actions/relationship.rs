//! How the viewer stands with another person: contacts, a pending contact
//! request either way, and their direct conversation.

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::auth::routes::direct_person_session_id;

/// The relationship for one person.
pub(in crate::common_ground) async fn relationship(
    pool: &PgPool,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<Value> {
    let mut all = relationships(pool, viewer, &[other.to_string()]).await?;
    Ok(all.remove(other).unwrap_or_else(none))
}

fn none() -> Value {
    json!({ "contact": false, "request": null, "requestId": null, "conversationId": null })
}

/// The relationship for each of `others`, with one query per table.
pub(in crate::common_ground) async fn relationships(
    pool: &PgPool,
    viewer: &str,
    others: &[String],
) -> sqlx_core::Result<HashMap<String, Value>> {
    let mut out: HashMap<String, Value> = others.iter().map(|o| (o.clone(), none())).collect();
    if others.is_empty() {
        return Ok(out);
    }
    let contacts: Vec<(String,)> = query_as(
        "SELECT peer_account_id FROM cloud_contacts
         WHERE account_id = $1 AND peer_account_id = ANY($2)",
    )
    .bind(viewer)
    .bind(others)
    .fetch_all(pool)
    .await?;
    for (other,) in contacts {
        if let Some(value) = out.get_mut(&other) {
            value["contact"] = json!(true);
        }
    }
    let requests: Vec<(String, String, String)> = query_as(
        "SELECT request_id, from_account_id, to_account_id FROM cloud_contact_requests
         WHERE status = 'pending'
           AND ((from_account_id = $1 AND to_account_id = ANY($2))
             OR (to_account_id = $1 AND from_account_id = ANY($2)))
         ORDER BY created_at DESC",
    )
    .bind(viewer)
    .bind(others)
    .fetch_all(pool)
    .await?;
    for (request_id, from, to) in requests {
        let (other, direction) = if from == viewer {
            (to, "outgoing")
        } else {
            (from, "incoming")
        };
        if let Some(value) = out.get_mut(&other) {
            if value["request"].is_null() && value["contact"] == json!(false) {
                value["request"] = json!(direction);
                value["requestId"] = json!(request_id);
            }
        }
    }
    let sessions: HashMap<String, &String> = others
        .iter()
        .map(|other| (direct_person_session_id(viewer, other), other))
        .collect();
    let keys: Vec<&String> = sessions.keys().collect();
    let conversations: Vec<(Uuid, String)> = query_as(
        "SELECT conversation_id, legacy_session_id FROM cloud_chat_conversations
         WHERE kind = 'direct' AND legacy_session_id = ANY($1)",
    )
    .bind(&keys)
    .fetch_all(pool)
    .await?;
    for (conversation_id, session_id) in conversations {
        if let Some(value) = sessions.get(&session_id).and_then(|o| out.get_mut(*o)) {
            value["conversationId"] = json!(conversation_id);
        }
    }
    Ok(out)
}

/// Sets `entry["relationship"]` from `all`, keyed by `account_id`.
pub(in crate::common_ground) fn attach(
    entry: &mut Value,
    account_id: &str,
    all: &HashMap<String, Value>,
) {
    entry["relationship"] = all.get(account_id).cloned().unwrap_or_else(none);
}
