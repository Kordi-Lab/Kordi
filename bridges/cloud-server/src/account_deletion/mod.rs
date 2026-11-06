//! Deleting an account (docs/development/account-deletion.md, owner
//! decision B1).
//!
//! [`prepare`] runs first, outside the transaction: steps that reach other
//! services and need the account's stored credentials. [`delete_in_transaction`]
//! then removes the account in the caller's transaction: conversations as
//! [`crate::chat_sync::store::remove_account_from_conversations`] describes,
//! then the account row, which cascades to its uploads, avatars, memories,
//! connectors, agents, devices, sessions, contacts and organizations. Object
//! keys are queued in the same transaction. [`after_commit`] logs every
//! device out, tells contacts, and starts deleting the queued objects.

use std::collections::HashSet;
use std::sync::Arc;

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use crate::avatars::assets::AVATAR_VARIANT_SIZES;
use crate::chat_sync::store::ConversationRemoval;
use crate::server::ServerState;

pub mod objects;

/// What a deletion removed, and who must hear about it after commit.
#[derive(Debug, Default)]
pub struct Deletion {
    pub devices: Vec<String>,
    pub contacts: Vec<String>,
    pub conversations: ConversationRemoval,
    pub queued_objects: usize,
}

impl Deletion {
    /// Counts for the audit event; never names the person.
    pub fn audit_metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "devices": self.devices.len(),
            "contacts": self.contacts.len(),
            "conversationsDeleted": self.conversations.deleted,
            "directConversationsEmptied": self.conversations.direct,
            "conversationsKept": self.conversations.kept,
            "groupsTransferred": self.conversations.transferred,
            "objectsQueued": self.queued_objects,
        })
    }
}

fn store_error(error: crate::chat_sync::store::StoreError) -> sqlx_core::Error {
    match error {
        crate::chat_sync::store::StoreError::Database(error) => error,
        error => sqlx_core::Error::Protocol(error.to_string()),
    }
}

/// Steps before the transaction. Each is best effort: deleting the account
/// must not fail because another service is unreachable.
pub async fn prepare(state: &ServerState, account_id: &str) {
    let pool = state.db_pool();
    // Revoke connector grants at their providers while the credentials
    // still exist; the local rows go with the account.
    match crate::connectors::store::list_live_connectors(pool, account_id).await {
        Ok(records) => {
            for record in records {
                if let Err(error) = crate::connectors::oauth::disconnect_connector(
                    pool,
                    state.connectors(),
                    &record,
                )
                .await
                {
                    eprintln!("[account-deletion] Could not disconnect a connector: {error}");
                }
            }
        }
        Err(error) => eprintln!("[account-deletion] Could not list connectors: {error}"),
    }
    // Sign in with Apple hook: a later change revokes the account's Apple
    // tokens here, with `revoke_apple_tokens_for_account(...)`, before the
    // stored refresh tokens are deleted with the account.
}

/// Deletes `account_id` in `tx`. The caller holds the account row lock and
/// commits.
pub async fn delete_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Deletion, sqlx_core::Error> {
    let devices: Vec<String> =
        query_as::<_, (String,)>("SELECT device_id FROM cloud_devices WHERE account_id = $1")
            .bind(account_id)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .map(|(id,)| id)
            .collect();
    let contacts: Vec<String> = query_as::<_, (String,)>(
        "SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 \
         UNION SELECT account_id FROM cloud_contacts WHERE peer_account_id = $1",
    )
    .bind(account_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    let attachments: Vec<(String, String)> = query_as(
        "SELECT attachment_id, object_key FROM cloud_attachments WHERE owner_account_id = $1",
    )
    .bind(account_id)
    .fetch_all(&mut **tx)
    .await?;
    let avatar_prefixes: Vec<(String,)> =
        query_as("SELECT object_prefix FROM cloud_avatar_assets WHERE owner_account_id = $1")
            .bind(account_id)
            .fetch_all(&mut **tx)
            .await?;
    let removed_attachments: HashSet<String> =
        attachments.iter().map(|(id, _)| id.clone()).collect();

    let conversations = crate::chat_sync::store::remove_account_from_conversations(
        tx,
        account_id,
        &removed_attachments,
    )
    .await
    .map_err(store_error)?;
    release_shared_rows(tx, account_id, &removed_attachments).await?;

    let mut keys: Vec<String> = attachments.into_iter().map(|(_, key)| key).collect();
    for (prefix,) in avatar_prefixes {
        keys.extend(
            AVATAR_VARIANT_SIZES
                .iter()
                .map(|size| format!("{prefix}/{size}.jpg")),
        );
    }
    let queued_objects = objects::queue(tx, &keys).await?;

    let deleted = query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(account_id)
        .execute(&mut **tx)
        .await?;
    if deleted.rows_affected() != 1 {
        return Err(sqlx_core::Error::RowNotFound);
    }
    Ok(Deletion {
        devices,
        contacts,
        conversations,
        queued_objects,
    })
}

/// Rows other people keep that point at the account's attachments,
/// sandboxes or personal organization, and records without a foreign key.
async fn release_shared_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    removed_attachments: &HashSet<String>,
) -> Result<(), sqlx_core::Error> {
    let removed: Vec<String> = removed_attachments.iter().cloned().collect();
    query(
        "DELETE FROM cloud_agent_run_artifacts WHERE attachment_id = ANY($1) \
            OR sandbox_id IN (SELECT sandbox_id FROM cloud_agent_sandboxes \
                              WHERE owner_account_id = $2 OR requester_account_id = $2)",
    )
    .bind(&removed)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    // Comments on other people's documents stay, with their replies, from
    // the stand-in. Comments on the account's own documents go with them.
    query(
        "UPDATE cloud_document_comments SET author_account_id = $2, author_name = $3 \
         WHERE author_account_id = $1 AND NOT (attachment_id = ANY($4))",
    )
    .bind(account_id)
    .bind(crate::deleted_account::DELETED_ACCOUNT_ID)
    .bind(crate::deleted_account::DELETED_DISPLAY_NAME)
    .bind(&removed)
    .execute(&mut **tx)
    .await?;
    // Content of other people that sits in the account's personal
    // organization moves to its owner's personal organization.
    for table in [
        "cloud_agent_definitions",
        "cloud_agent_fallback_runs",
        "scheduled_tool_tasks",
        "scheduled_tool_task_runs",
        "cloud_attachments",
    ] {
        query(&format!(
            "UPDATE {table} SET organization_id = cloud_personal_organization(owner_account_id) \
             WHERE organization_id = cloud_personal_organization($1) \
               AND owner_account_id <> $1"
        ))
        .bind(account_id)
        .execute(&mut **tx)
        .await?;
    }
    // Other people's digests built from the account's messages are cleared
    // and rebuilt without them.
    query(
        "UPDATE cloud_account_digests SET snapshot_json = NULL, snapshot_input_json = NULL, \
           input_json = '{}', input_hash = '', last_full_at = NULL, \
           dirty_since = COALESCE(dirty_since, now()), last_change_at = now(), \
           revision = revision + 1, updated_at = now() \
         WHERE account_id <> $1 \
           AND (strpos(COALESCE(snapshot_json::text, ''), $1) > 0 \
                OR strpos(COALESCE(snapshot_input_json::text, ''), $1) > 0 \
                OR strpos(input_json::text, $1) > 0)",
    )
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    // A waitlist request under any of the account's emails.
    query(
        "DELETE FROM cloud_access_waitlist WHERE lower(email) IN ( \
           SELECT lower(primary_email) FROM cloud_accounts \
           WHERE account_id = $1 AND primary_email IS NOT NULL \
           UNION SELECT lower(email) FROM cloud_account_identities \
           WHERE account_id = $1 AND email IS NOT NULL)",
    )
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    for sql in [
        "DELETE FROM cloud_agent_omp_state WHERE owner_account_id = $1",
        "DELETE FROM cloud_connector_audit WHERE account_id = $1",
        "DELETE FROM cloud_connector_removal_requests WHERE account_id = $1",
        "DELETE FROM cloud_audit_events WHERE account_id = $1",
    ] {
        query(sql).bind(account_id).execute(&mut **tx).await?;
    }
    Ok(())
}

/// After commit: every device is logged out and its live connections close,
/// contacts' devices drop the contact, and queued objects start deleting.
pub fn after_commit(state: Arc<ServerState>, account_id: String, deletion: Deletion) {
    tokio::spawn(async move {
        let events = state.events();
        for device_id in &deletion.devices {
            events.publish_device_revoked(device_id).await;
        }
        for peer in &deletion.contacts {
            events.publish_contact_removed(&account_id, peer).await;
        }
        objects::drain(&state).await;
    });
}
