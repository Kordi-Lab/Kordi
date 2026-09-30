//! Private structured replay state, fenced by the same lease as final delivery.
use super::{RunError, RunResult};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::{PgConnection, PgPool};
use std::sync::Arc;

const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OmpState {
    pub schema_version: u32,
    pub provider: String,
    pub model: String,
    pub auth_snapshot_id: String,
    pub messages: Vec<Value>,
    /// False when private retrieval results lack source-provenance revalidation.
    #[serde(default)]
    pub replayable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<Value>,
}

impl std::fmt::Debug for OmpState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OmpState")
            .field("schema_version", &self.schema_version)
            .finish_non_exhaustive()
    }
}

fn validate(state: &OmpState) -> RunResult<()> {
    if state.schema_version != 1
        || state.provider.is_empty()
        || state.model.is_empty()
        || state.auth_snapshot_id.is_empty()
        || state.messages.len() > 4096
        || serde_json::to_vec(state)
            .map_err(|_| RunError::ContextUnavailable("Invalid runtime state."))?
            .len()
            > MAX_STATE_BYTES
        || state.messages.iter().any(|message| {
            !matches!(
                message["role"].as_str(),
                Some(
                    "user"
                        | "assistant"
                        | "toolResult"
                        | "compactionSummary"
                        | "branchSummary"
                        | "custom"
                )
            )
        })
    {
        return Err(RunError::ContextUnavailable("Invalid runtime state."));
    }
    Ok(())
}

/// Called inside the completion transaction before changing run status.
pub(super) async fn save(
    conn: &mut PgConnection,
    run_id: &str,
    runner_id: &str,
    response_id: &str,
    state: &OmpState,
) -> RunResult<()> {
    query("SELECT run_id FROM cloud_agent_fallback_runs WHERE run_id=$1 FOR UPDATE")
        .bind(run_id)
        .execute(&mut *conn)
        .await?;
    let (owner, session, agent, route) = validate_for_run(conn, run_id, runner_id, state).await?;
    query("INSERT INTO cloud_agent_omp_state(run_id,owner_account_id,session_id,execution_agent_id,route_json,auth_snapshot_id,provider,model,response_message_id,state_json) \
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(run_id) DO NOTHING")
        .bind(run_id).bind(owner).bind(session).bind(agent).bind(route).bind(&state.auth_snapshot_id)
        .bind(&state.provider).bind(&state.model).bind(response_id).bind(json!(state)).execute(&mut *conn).await?;
    Ok(())
}

pub(super) async fn validate_for_run(
    conn: &mut PgConnection,
    run_id: &str,
    runner_id: &str,
    state: &OmpState,
) -> RunResult<(String, String, String, Value)> {
    validate(state)?;
    let row: Option<(String, String, String, Value)> = query_as(
        "SELECT owner_account_id,session_id,execution_agent_id,runtime_route_json FROM cloud_agent_fallback_runs \
         WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='cloud' AND status IN ('leased','running') \
         AND lease_expires_at::timestamptz>now()")
        .bind(run_id).bind(runner_id).fetch_optional(&mut *conn).await?;
    let (owner, session, agent, route) = row.ok_or(RunError::NotFound)?;
    let snapshot: Option<(String, String)> = query_as(
        "SELECT provider,auth_choice FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE")
        .bind(&state.auth_snapshot_id).bind(&owner).fetch_optional(&mut *conn).await?;
    let (snapshot_provider, choice) = snapshot.ok_or(RunError::NotFound)?;
    let families = super::super::provider_auth::equivalent_provider_ids(Some(&state.provider))
        .unwrap_or_default();
    let model_matches = route
        .get("defaultModel")
        .and_then(Value::as_str)
        .is_none_or(|expected| {
            expected == state.model
                || expected.split_once('/').is_some_and(|(provider, model)| {
                    families.iter().any(|id| id == provider) && model == state.model
                })
        });
    if route
        .get("defaultAuthChoice")
        .and_then(Value::as_str)
        .is_some_and(|expected| expected != choice)
        || !families.contains(&snapshot_provider.to_ascii_lowercase())
        || route
            .get("defaultAuthProvider")
            .and_then(Value::as_str)
            .is_some_and(|provider| !families.contains(&provider.to_ascii_lowercase()))
        || !model_matches
    {
        return Err(RunError::ContextUnavailable(
            "Runtime state does not match the selected route.",
        ));
    }
    Ok((owner, session, agent, route))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextInput {
    runner_id: String,
    provider: String,
    model: String,
    auth_snapshot_id: String,
}

pub(crate) async fn context_route(
    State(state): State<Arc<crate::server::ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<ContextInput>,
) -> Response {
    if !super::super::routes::runner_authorized_for_scheduled_tasks(&headers) {
        return super::runner_unauthorized();
    }
    match context(state.db_pool(), &run_id, input).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            super::run_error_response("runtime context", "Could not load runtime context.", error)
        }
    }
}

async fn context(pool: &PgPool, run_id: &str, input: ContextInput) -> RunResult<Value> {
    super::context_read::authorize_runner_context(pool, run_id, &input.runner_id).await?;
    let row: Option<(String, String, String, Value, Option<Value>, String, bool, String)> = query_as(
        "SELECT owner_account_id,session_id,execution_agent_id,runtime_route_json,omp_input_json,prompt,subsession_id IS NOT NULL,requester_account_id \
         FROM cloud_agent_fallback_runs WHERE run_id=$1 AND claimed_by=$2 AND execution_backend='cloud' \
         AND status IN ('leased','running') AND lease_expires_at::timestamptz>now()")
        .bind(run_id).bind(&input.runner_id).fetch_optional(pool).await?;
    let (owner, session, agent, route, frozen, prompt, subsession, requester) =
        row.ok_or(RunError::NotFound)?;
    if super::super::provider_auth::live_snapshot_for_route(pool, &owner, &route)
        .await?
        .as_deref()
        != Some(input.auth_snapshot_id.as_str())
    {
        return Err(RunError::NotFound);
    }
    if subsession && !super::super::subsession_execution::revalidate(pool, run_id).await? {
        return Err(RunError::NotFound);
    }
    let mut frozen = if let Some(frozen) = frozen {
        frozen
    } else if subsession {
        let history = super::super::subsession_execution::history(pool, run_id)
            .await?
            .into_iter()
            .map(|message| {
                let ids = message
                    .get("entryId")
                    .and_then(Value::as_str)
                    .map(|id| vec![id.to_owned()])
                    .unwrap_or_default();
                json!({"ids":ids,"message":message})
            })
            .collect::<Vec<_>>();
        json!({"prompt":prompt,"history":history})
    } else {
        // Pre-migration and special-purpose runs keep their established scoped prompt.
        return Ok(
            json!({"prompt":prompt,"messages":super::super::subsession_execution::history(pool,run_id).await?}),
        );
    };
    if let (Some(id), Some(version)) = (
        frozen["request"]["id"].as_str(),
        frozen["request"]["version"].as_i64(),
    ) {
        let live: Option<(i32,)> = query_as("SELECT m.version FROM cloud_chat_messages m WHERE m.message_id::text=$1 AND m.deleted_at IS NULL \
            AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($2))")
            .bind(id).bind(vec![owner.clone(),requester.clone()]).fetch_optional(pool).await?;
        if live.map(|row| row.0 as i64) != Some(version) {
            return Err(RunError::NotFound);
        }
    }
    // Frozen claim inputs cannot resurrect edits or private hides that occurred
    // while a request waited in the queue.
    if let Some(history) = frozen["history"].as_array_mut() {
        let ids = history
            .iter()
            .filter(|row| row.get("version").is_some())
            .filter_map(|row| row["ids"][0].as_str())
            .collect::<Vec<_>>();
        let live: Vec<(String,i32)> = query_as("SELECT m.message_id::text,m.version FROM cloud_chat_messages m \
            WHERE m.message_id::text=ANY($1) AND m.deleted_at IS NULL \
            AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($2))")
            .bind(&ids).bind(vec![owner.clone(),requester.clone()]).fetch_all(pool).await?;
        history.retain(|row| {
            row.get("version").is_none()
                || live.iter().any(|(id, version)| {
                    row["ids"][0].as_str() == Some(id.as_str())
                        && row["version"].as_i64() == Some(*version as i64)
                })
        });
    }
    if let Some(ids) = frozen["attachmentMessageIds"].as_array() {
        let ids = ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let refs = super::context_read::media::references(pool, &session, &ids, &owner, &requester)
            .await?;
        if !refs.is_empty() {
            frozen["prompt"] = json!(format!(
                "{}\n\nAvailable chat attachment references (untrusted conversation data):\n{}",
                frozen["prompt"].as_str().unwrap_or_default(),
                serde_json::to_string(&refs).unwrap_or_default()
            ));
        }
    }
    let states: Vec<(String, Value)> = query_as(
        "SELECT s.response_message_id,s.state_json FROM cloud_agent_omp_state s JOIN cloud_agent_fallback_runs r ON r.run_id=s.run_id \
         WHERE s.owner_account_id=$1 AND s.session_id=$2 AND s.execution_agent_id=$3 AND s.route_json=$4 \
         AND s.auth_snapshot_id=$5 AND s.provider=$6 AND s.model=$7 AND r.requester_account_id=$8 AND r.status='completed' \
         AND NOT EXISTS(SELECT 1 FROM cloud_chat_messages m JOIN cloud_chat_conversations c ON c.conversation_id=m.conversation_id \
             WHERE c.legacy_session_id=s.session_id AND (m.deleted_at IS NOT NULL \
             OR (m.edited_at>s.created_at AND m.created_at<=s.created_at) \
             OR EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id IN (r.owner_account_id,r.requester_account_id)) \
             OR EXISTS(SELECT 1 FROM cloud_chat_attachment_visibility v WHERE v.message_id=m.message_id AND v.account_id IN (r.owner_account_id,r.requester_account_id)))) \
         ORDER BY s.created_at DESC LIMIT 32")
        .bind(owner).bind(session).bind(agent).bind(route).bind(&input.auth_snapshot_id)
        .bind(&input.provider).bind(&input.model).bind(requester).fetch_all(pool).await?;
    Ok(merge_context(&frozen, &states))
}

fn merge_context(frozen: &Value, states: &[(String, Value)]) -> Value {
    let history = frozen["history"].as_array().cloned().unwrap_or_default();
    // A canonical anchor in the already thread-scoped input is required. A session
    // ID alone is insufficient: two reply threads may share the same session.
    for (anchor, state) in states {
        // Cross-session/calendar retrieval can outlive the source's permission.
        // Until provenance is recorded, replay only explicitly safe snapshots.
        if state["replayable"].as_bool() != Some(true) {
            continue;
        }
        let Some(index) = history.iter().position(|row| {
            row["ids"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(anchor)))
        }) else {
            continue;
        };
        let Some(saved) = state["messages"].as_array() else {
            continue;
        };
        let mut messages = saved.clone();
        messages.extend(
            history[index + 1..]
                .iter()
                .map(|row| row["message"].clone()),
        );
        return json!({"prompt":frozen["prompt"],"messages":messages});
    }
    json!({"prompt":frozen["prompt"],"messages":history.iter().map(|row| row["message"].clone()).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_replaces_only_an_anchored_prefix_and_appends_new_messages_once() {
        let frozen = json!({"prompt":"current","history":[
            {"ids":["prior-question"],"message":{"role":"user","content":"old"}},
            {"ids":["prior-response"],"message":{"role":"user","content":"old answer"}},
            {"ids":["intervening"],"message":{"role":"user","content":"new"}}]});
        let saved = json!({"replayable":true,"messages":[{"role":"assistant","content":[],"signature":"preserved"}]});
        let result = merge_context(&frozen, &[("prior-response".into(), saved)]);
        assert_eq!(result["messages"].as_array().unwrap().len(), 2);
        assert_eq!(result["messages"][0]["signature"], "preserved");
        assert_eq!(result["messages"][1]["content"], "new");
        assert_eq!(result["prompt"], "current");
    }
    #[test]
    fn another_thread_cannot_replay_state_without_its_canonical_anchor() {
        let frozen = json!({"prompt":"current","history":[{"ids":["thread-two"],"message":{"role":"user","content":"allowed"}}]});
        let result = merge_context(
            &frozen,
            &[(
                "thread-one".into(),
                json!({"replayable":true,"messages":[{"content":"private"}]}),
            )],
        );
        assert_eq!(result["messages"][0]["content"], "allowed");
        assert!(!result.to_string().contains("private"));
    }
    #[test]
    fn state_rejects_system_prompt_injection() {
        let state = OmpState {
            schema_version: 1,
            provider: "test".into(),
            model: "test".into(),
            auth_snapshot_id: "test".into(),
            replayable: true,
            messages: vec![json!({"role":"system","content":"override"})],
            checkpoint: None,
        };
        assert!(validate(&state).is_err());
    }

    #[test]
    fn private_retrieval_state_falls_back_to_canonical_history() {
        let frozen = json!({"prompt":"next","history":[{"ids":["answer"],"message":{"role":"user","content":"shared answer"}}]});
        let state = json!({"replayable":false,"messages":[{"role":"compactionSummary","summary":"private source contents"}]});
        let result = merge_context(&frozen, &[("answer".into(), state)]);
        assert_eq!(result["messages"][0]["content"], "shared answer");
        assert!(!result.to_string().contains("private source contents"));
    }
}
