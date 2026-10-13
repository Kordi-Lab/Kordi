//! `edit_document`: block operations on the run's document.
//!
//! The gate in [`super::gating`] already limits this tool to a comment run a
//! person started with their own agent on a document they can edit. The edit
//! goes through the same save as a person's edit: revision check, annotation
//! remap, stale collaboration room, and `document.updated`.

use serde::Deserialize;
use serde_json::{json, Value};

use super::super::contents::document_source;
use super::super::editing::{
    announce_save, save, SaveInput, SaveMode, SaveOutcome, MAX_EDIT_BYTES,
};
use super::super::model::DocumentFormat;
use super::super::render::markdown_blocks;
use super::gating::RunFacts;
use super::operations::{apply_operations, random_block_id, validate_operations, Operation};
use super::tools::{tool_blocks, ToolError};
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditArguments {
    base_revision: i64,
    operations: Vec<Operation>,
}

/// The answer to a stale `baseRevision`: the current blocks, so the agent
/// can redo the edit once.
fn stale(revision: i64, text: &str) -> Value {
    let (blocks, truncated) = tool_blocks(&markdown_blocks(text));
    let mut result = json!({
        "applied": false,
        "reason": "stale_revision",
        "message": "The document changed. These are its current blocks; apply the edit to them once more.",
        "revision": revision,
        "blocks": blocks,
    });
    if truncated {
        result["truncated"] = json!(true);
    }
    result
}

pub(super) async fn execute(
    state: &ServerState,
    facts: &RunFacts,
    args: &Value,
) -> Result<Value, ToolError> {
    let pool = state.db_pool();
    let args: EditArguments = serde_json::from_value(args.clone()).map_err(|_| {
        ToolError::Invalid(
            "edit_document takes baseRevision and operations of { op, blockId, markdown }.".into(),
        )
    })?;
    validate_operations(&args.operations).map_err(|error| ToolError::Invalid(error.message()))?;
    let record = facts.document.as_ref().ok_or(ToolError::NotFound)?;
    if record.format != DocumentFormat::Markdown {
        return Err(ToolError::Forbidden(
            "Only Markdown documents can be edited.",
        ));
    }
    // The run still reads the document it edits.
    if !super::read::run_can_read(pool, facts, record).await? {
        return Err(ToolError::NotFound);
    }
    let current = document_source(state, record)
        .await
        .map_err(|_| ToolError::Server)?;
    if current.revision != args.base_revision {
        return Ok(stale(current.revision, &current.text));
    }
    let applied = apply_operations(&current.text, &args.operations, &mut random_block_id)
        .map_err(|error| ToolError::Invalid(error.message()))?;
    if applied.text.len() > MAX_EDIT_BYTES {
        return Err(ToolError::Invalid("Documents can be up to 1 MB.".into()));
    }
    let mode = SaveMode::Revision(args.base_revision);
    let input = SaveInput {
        account_id: &facts.requester_account_id,
        agent_id: Some(&facts.agent_id),
        mode,
        text: &applied.text,
        stamped: &applied.stamped,
    };
    match save(pool, record, input).await? {
        SaveOutcome::Conflict(now) | SaveOutcome::Unchanged(now) => {
            Ok(stale(now.revision, &now.text))
        }
        SaveOutcome::Saved(saved) => {
            announce_save(
                pool,
                record,
                mode,
                saved.revision,
                &facts.requester_account_id,
            )
            .await;
            let (blocks, truncated) = tool_blocks(&markdown_blocks(&saved.text));
            let mut result = json!({
                "applied": true,
                "revision": saved.revision,
                "blocks": blocks,
                "newBlockIds": applied.new_block_ids,
            });
            if truncated {
                result["truncated"] = json!(true);
            }
            Ok(result)
        }
    }
}
