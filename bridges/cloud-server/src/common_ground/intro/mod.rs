//! Group intros: a group started from a room opens with PiP introducing
//! everyone, written by one plain completion on the Kordi key. Invited
//! people who join later get a templated line instead, with no model call.

mod prompt;

use std::collections::HashMap;

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use self::prompt::{intro_prompt, joined_line, Introduced, Role, INTRO_SYSTEM};
use super::card::Topics;
use super::matching::shared_cards;
use super::runs::{self, NewRun, INTRO_PREFIX};
use crate::chat_sync::models::SendMessageRequest;
use crate::document_shares::access::clean_display_name;

/// The longest intro PiP posts.
const MAX_INTRO_CHARS: usize = 1_200;

/// A new group to introduce.
pub(super) struct NewIntro<'a> {
    pub room_id: Uuid,
    pub group_space_id: &'a str,
    pub conversation_id: Uuid,
    pub name: &'a str,
    pub topic: Option<&'a str>,
    pub creator: &'a str,
    pub added: &'a [String],
    pub invited: &'a [String],
}

/// The (account, profile) pairs these accounts joined `room_id` with.
async fn room_profiles(
    pool: &PgPool,
    room_id: Uuid,
    ids: &[String],
) -> sqlx_core::Result<Vec<(String, String)>> {
    query_as(
        "SELECT account_id, profile_id FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND account_id = ANY($2)",
    )
    .bind(room_id)
    .bind(ids)
    .fetch_all(pool)
    .await
}

/// Display names and the cards `accounts` share in the room.
async fn introduced(
    pool: &PgPool,
    room_id: Uuid,
    accounts: &[(String, Role)],
) -> sqlx_core::Result<Vec<Introduced>> {
    let ids: Vec<String> = accounts.iter().map(|(id, _)| id.clone()).collect();
    let members = room_profiles(pool, room_id, &ids).await?;
    let mut cards: HashMap<String, Topics> = shared_cards(pool, &members)
        .await?
        .into_iter()
        .map(|card| (card.account_id, card.topics))
        .collect();
    let names: HashMap<String, Option<String>> =
        query_as("SELECT account_id, display_name FROM cloud_accounts WHERE account_id = ANY($1)")
            .bind(&ids)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    Ok(accounts
        .iter()
        .filter_map(|(id, role)| {
            let name = names.get(id)?;
            Some(Introduced {
                name: clean_display_name(name.as_deref()),
                role: *role,
                topics: cards.remove(id),
            })
        })
        .collect())
}

/// Queues the intro run for a group that was just created.
pub(super) async fn queue(
    pool: &PgPool,
    service: &crate::pip::PipConfig,
    intro: NewIntro<'_>,
) -> sqlx_core::Result<()> {
    let accounts: Vec<(String, Role)> = std::iter::once((intro.creator.to_string(), Role::Creator))
        .chain(intro.added.iter().map(|id| (id.clone(), Role::Added)))
        .chain(intro.invited.iter().map(|id| (id.clone(), Role::Invited)))
        .collect();
    let people = introduced(pool, intro.room_id, &accounts).await?;
    let run_id = runs::new_run_id(INTRO_PREFIX);
    let mut tx = pool.begin().await?;
    query(
        "INSERT INTO cloud_common_ground_group_intros (run_id, conversation_id, group_space_id)
         VALUES ($1, $2, $3)",
    )
    .bind(&run_id)
    .bind(intro.conversation_id)
    .bind(intro.group_space_id)
    .execute(&mut *tx)
    .await?;
    let new_run = NewRun {
        run_id: &run_id,
        requester: intro.creator,
        prompt: intro_prompt(intro.name, intro.topic, &people),
        system_prompt: INTRO_SYSTEM,
    };
    runs::insert(&mut tx, service, new_run).await?;
    tx.commit().await
}

fn text_message(client_message_id: Uuid, text: &str) -> SendMessageRequest {
    SendMessageRequest {
        client_message_id,
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [{ "type": "text", "text": text }],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    }
}

fn store_error(error: crate::chat_sync::store::StoreError) -> sqlx_core::Error {
    sqlx_core::Error::Protocol(error.to_string())
}

/// The intro text as posted: trimmed and capped.
fn clean_reply(text: &str) -> String {
    text.trim()
        .chars()
        .take(MAX_INTRO_CHARS)
        .collect::<String>()
}

/// Posts a finished intro run's reply into its group as PiP. An empty reply,
/// or one that cannot be posted, fails the run instead.
pub(super) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<(Uuid, String)> = query_as(
        "SELECT intro.conversation_id, run.owner_account_id
         FROM cloud_common_ground_group_intros intro
         JOIN cloud_agent_fallback_runs run ON run.run_id = intro.run_id
         WHERE intro.run_id = $1 AND intro.posted_at IS NULL AND intro.error_code IS NULL",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((conversation_id, pip_account)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let text = clean_reply(text);
    if text.is_empty() {
        eprintln!("[common-ground] Rejected run {run_id}: the intro is empty");
        return fail(pool, run_id, Some(runner_id), "invalid_output").await;
    }
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    let message_id = Uuid::new_v5(&Uuid::NAMESPACE_OID, run_id.as_bytes());
    let posted = crate::chat_sync::store::send_message_in_transaction(
        &mut tx,
        &pip_account,
        conversation_id,
        text_message(message_id, &text),
    )
    .await;
    if let Err(error) = posted {
        drop(tx);
        eprintln!("[common-ground] Could not post the intro for run {run_id}: {error}");
        return fail(pool, run_id, Some(runner_id), "post_failed").await;
    }
    query("UPDATE cloud_common_ground_group_intros SET posted_at = now() WHERE run_id = $1")
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// Records why an intro run failed. Nothing is posted.
pub(super) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    // A runner that lost its lease, or a repeated report, changes nothing.
    if !runs::mark_failed(&mut tx, run_id, runner_id, code, "The group intro failed.").await? {
        return Ok(());
    }
    query(
        "UPDATE cloud_common_ground_group_intros SET error_code = $2
         WHERE run_id = $1 AND posted_at IS NULL",
    )
    .bind(run_id)
    .bind(code)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Posts "<Name> joined. …" as PiP in the group `account` just joined.
pub(super) async fn post_joined(
    pool: &PgPool,
    pip_account: &str,
    room_id: Uuid,
    conversation_id: Uuid,
    account: &str,
) -> sqlx_core::Result<()> {
    let name: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(account)
            .fetch_optional(pool)
            .await?;
    let Some((name,)) = name else {
        return Ok(());
    };
    let members = room_profiles(pool, room_id, &[account.to_string()]).await?;
    let card = shared_cards(pool, &members).await?;
    let line = joined_line(
        &clean_display_name(name.as_deref()),
        card.first().map(|card| &card.topics),
    );
    let message_id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("common-ground-joined:{conversation_id}:{account}").as_bytes(),
    );
    crate::chat_sync::store::send_message(
        pool,
        pip_account,
        conversation_id,
        text_message(message_id, &line),
    )
    .await
    .map(|_| ())
    .map_err(store_error)
}
