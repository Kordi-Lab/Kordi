//! Saving an edited Markdown document.
//!
//! A save carries the whole source and the revision it was based on. A stale
//! base revision answers `409 document_revision_conflict` with the current
//! document. In the same transaction as an accepted save, reactions and
//! comments move with their blocks (see [`super::render::remap_block_ids`]).
//! Afterwards every member is told to reload through `document.updated`
//! (see [`super::events`]).

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::access::{authorized_document, DocumentRecord};
use super::canonical::can_edit;
use super::contents::{document_source, DocumentSource};
use super::documents::signed_in_response;
use super::events::{publish_document_updated, DocumentChange};
use super::model::{RevisionConflict, SaveContentRequest};
use super::render::{markdown_blocks, remap_block_ids, resolve_remap};
use super::{db_error, err};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// Largest source a save accepts.
pub(crate) const MAX_EDIT_BYTES: usize = 1024 * 1024;

fn edit_forbidden() -> Response {
    err(
        "document_edit_forbidden",
        "You can't edit this document.",
        StatusCode::FORBIDDEN,
    )
}

enum SaveOutcome {
    Saved(DocumentSource),
    Conflict(DocumentSource),
}

/// `PUT /v1/cloud/documents/:attachment_id/content`
pub(crate) async fn save_content(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(req): Json<SaveContentRequest>,
) -> Response {
    if req.source.len() > MAX_EDIT_BYTES {
        return err(
            "document_too_large",
            "Documents can be up to 1 MB.",
            StatusCode::PAYLOAD_TOO_LARGE,
        );
    }
    let (record, viewer) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let pool = state.db_pool();
    let can_edit = match can_edit(pool, &record, viewer, &session.account_id).await {
        Ok(value) => value,
        Err(_) => return db_error(),
    };
    if !can_edit {
        return edit_forbidden();
    }
    // Seeds revision 1 from the attachment when nobody has opened it yet.
    if let Err(response) = document_source(&state, &record).await {
        return *response;
    }
    let text = super::contents::decode_source(req.source.as_bytes());
    let outcome = match save(pool, &record, &session.account_id, req.base_revision, &text).await {
        Ok(outcome) => outcome,
        Err(_) => return db_error(),
    };
    match outcome {
        SaveOutcome::Conflict(current) => {
            match signed_in_response(&state, &session, &record, viewer, &current).await {
                Ok(document) => (
                    StatusCode::CONFLICT,
                    Json(RevisionConflict {
                        error_code: "document_revision_conflict",
                        message: "Someone else changed this document.",
                        document,
                    }),
                )
                    .into_response(),
                Err(response) => *response,
            }
        }
        SaveOutcome::Saved(saved) => {
            publish_document_updated(
                pool,
                &record,
                Some(saved.revision),
                DocumentChange::Content,
                Some(&session.account_id),
            )
            .await;
            match signed_in_response(&state, &session, &record, viewer, &saved).await {
                Ok(document) => Json(document).into_response(),
                Err(response) => *response,
            }
        }
    }
}

async fn save(
    pool: &PgPool,
    record: &DocumentRecord,
    account_id: &str,
    base_revision: i64,
    text: &str,
) -> Result<SaveOutcome, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let (old_text, revision, updated_at): (String, i64, String) = query_as(
        "SELECT source, revision, updated_at FROM cloud_document_contents \
         WHERE attachment_id = $1 FOR UPDATE",
    )
    .bind(&record.attachment_id)
    .fetch_one(&mut *tx)
    .await?;
    if revision != base_revision {
        tx.rollback().await?;
        return Ok(SaveOutcome::Conflict(DocumentSource {
            text: old_text,
            revision,
            updated_at: (revision > 1).then_some(updated_at),
        }));
    }
    let now = Utc::now().to_rfc3339();
    let (new_revision,): (i64,) = query_as(
        "UPDATE cloud_document_contents \
         SET source = $2, revision = revision + 1, updated_by_account_id = $3, updated_at = $4 \
         WHERE attachment_id = $1 RETURNING revision",
    )
    .bind(&record.attachment_id)
    .bind(text)
    .bind(account_id)
    .bind(&now)
    .fetch_one(&mut *tx)
    .await?;
    let sources = |value: &str| -> Vec<String> {
        markdown_blocks(value)
            .into_iter()
            .map(|block| block.source)
            .collect()
    };
    let targets = resolve_remap(&remap_block_ids(&sources(&old_text), &sources(text)));
    remap_annotations(&mut tx, &record.attachment_id, &targets, &now).await?;
    tx.commit().await?;
    Ok(SaveOutcome::Saved(DocumentSource {
        text: text.to_string(),
        revision: new_revision,
        updated_at: Some(now),
    }))
}

/// The block index an annotation on `block_id` moves to.
fn target_block(block_id: &str, targets: &[usize]) -> Option<usize> {
    let index: usize = block_id.strip_prefix('b')?.parse().ok()?;
    Some(targets.get(index).copied().unwrap_or(index))
}

/// Moves comments and live reactions with their blocks. Reactions that would
/// duplicate one already on the target block (same actor and emoji) are
/// removed, keeping the oldest.
async fn remap_annotations(
    tx: &mut Transaction<'_, Postgres>,
    attachment_id: &str,
    targets: &[usize],
    now: &str,
) -> Result<(), sqlx_core::Error> {
    let (old, new): (Vec<String>, Vec<String>) = targets
        .iter()
        .enumerate()
        .filter(|(index, target)| index != *target)
        .map(|(index, target)| (format!("b{index}"), format!("b{target}")))
        .unzip();
    if old.is_empty() {
        return Ok(());
    }
    query(
        "UPDATE cloud_document_comments comment SET block_id = map.new \
         FROM unnest($2::text[], $3::text[]) AS map(old, new) \
         WHERE comment.attachment_id = $1 AND comment.block_id = map.old",
    )
    .bind(attachment_id)
    .bind(&old)
    .bind(&new)
    .execute(&mut **tx)
    .await?;

    type LiveReaction = (String, String, String, Option<String>, Option<String>);
    let live: Vec<LiveReaction> = query_as(
        "SELECT reaction_id, block_id, reaction, actor_account_id, actor_reader_key \
         FROM cloud_document_reactions \
         WHERE attachment_id = $1 AND deleted_at IS NULL \
         ORDER BY created_at ASC, reaction_id ASC",
    )
    .bind(attachment_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut seen = HashSet::new();
    let mut duplicates = Vec::new();
    let (mut moved_ids, mut moved_blocks) = (Vec::new(), Vec::new());
    for (reaction_id, block_id, reaction, account, reader) in live {
        let Some(target) = target_block(&block_id, targets) else {
            continue;
        };
        let target_id = format!("b{target}");
        if !seen.insert((target_id.clone(), reaction, account, reader)) {
            duplicates.push(reaction_id);
        } else if target_id != block_id {
            moved_ids.push(reaction_id);
            moved_blocks.push(target_id);
        }
    }
    query("UPDATE cloud_document_reactions SET deleted_at = $2 WHERE reaction_id = ANY($1)")
        .bind(&duplicates)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    // Moved rows leave the live unique index first and come back in one
    // statement, so a swap of two blocks cannot collide midway.
    query(
        "UPDATE cloud_document_reactions SET deleted_at = 'remapping' \
         WHERE reaction_id = ANY($1)",
    )
    .bind(&moved_ids)
    .execute(&mut **tx)
    .await?;
    query(
        "UPDATE cloud_document_reactions reaction \
         SET block_id = map.block_id, deleted_at = NULL \
         FROM unnest($1::text[], $2::text[]) AS map(reaction_id, block_id) \
         WHERE reaction.reaction_id = map.reaction_id",
    )
    .bind(&moved_ids)
    .bind(&moved_blocks)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
