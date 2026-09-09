//! Owner-published model execution records, authorized by the parent conversation.
mod catalog;
pub(crate) mod conversation;
mod stop;
use crate::{
    auth::routes::CloudSession, chat_sync::store::conversation_id_for_session, server::ServerState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::get,
    Extension, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

type PublishedSubsessionRow = (
    String,
    String,
    Uuid,
    String,
    String,
    i64,
    String,
    String,
    Value,
);

type ApiError = (StatusCode, Json<Value>);
fn error(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({"error":{"code":code,"message":code}})))
}
fn db_error(_: impl std::fmt::Display) -> ApiError {
    error(StatusCode::INTERNAL_SERVER_ERROR, "subsession_store_error")
}

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v1/cloud/agent-subsessions", get(catalog::list))
        .route("/v1/cloud/agent-subsessions/:id", get(read).put(write))
        .route(
            "/v1/cloud/agent-subsessions/:id/stop",
            axum::routing::post(stop::stop),
        )
        .route(
            "/v1/cloud/agent-subsessions/:id/messages",
            axum::routing::post(conversation::send),
        )
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    id: String,
    role: String,
    text: String,
    timestamp_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteRequest {
    #[serde(default)]
    activity: Value,
    parent_session_id: String,
    parent_request_id: String,
    title: String,
    status: String,
    messages: Vec<Message>,
    expected_version: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReadQuery {
    #[serde(default)]
    include_messages: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    activity: Value,
    has_followup_execution: bool,
    live: bool,
    queued: bool,
    started_at_ms: Option<i64>,
    participants: Vec<Value>,
    session_id: Uuid,
    parent_session_id: String,
    parent_request_id: String,
    owner_account_id: String,
    agent_id: String,
    owner_display_name: String,
    agent_display_name: String,
    agent_avatar_url: Option<String>,
    title: String,
    status: String,
    version: i64,
    messages: Vec<Value>,
    updated_at: String,
}

fn validate(request: &WriteRequest) -> bool {
    !request.parent_session_id.trim().is_empty()
        && request.parent_session_id.len() <= 256
        && !request.parent_request_id.trim().is_empty()
        && request.parent_request_id.len() <= 256
        && !request.title.trim().is_empty()
        && request.title.chars().count() <= 120
        && matches!(
            request.status.as_str(),
            "running" | "done" | "failed" | "stopped"
        )
        && request.expected_version >= 0
        && request.messages.len() <= 256
        && request
            .messages
            .iter()
            .map(|message| message.text.len())
            .sum::<usize>()
            <= 2 * 1024 * 1024
        && request
            .messages
            .iter()
            .map(|message| &message.id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            == request.messages.len()
        && request.messages.iter().all(|message| {
            !message.id.is_empty()
                && message.id.len() <= 256
                && matches!(message.role.as_str(), "user" | "assistant")
        })
}

fn payload(body: &str) -> Option<Value> {
    let (prefix, encoded) = body.split_once(':')?;
    if !matches!(prefix, "kordi-cloud-group" | "kordi-cloud-message") {
        return None;
    }
    let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    if prefix == "kordi-cloud-group" {
        value.get("message").cloned()
    } else {
        Some(value)
    }
}

async fn request_agent(
    pool: &PgPool,
    conversation_id: Uuid,
    request_id: &str,
    owner: &str,
) -> Result<String, ApiError> {
    let kind: (String,) =
        query_as("SELECT kind FROM cloud_chat_conversations WHERE conversation_id=$1")
            .bind(conversation_id)
            .fetch_one(pool)
            .await
            .map_err(db_error)?;
    let mut rows = query_as::<_, (Uuid, Uuid, String, Value)>(
        "SELECT message_id, client_message_id, sender_account_id, content FROM cloud_chat_messages WHERE conversation_id=$1 AND deleted_at IS NULL ORDER BY conversation_sequence DESC"
    ).bind(conversation_id).fetch(pool);
    while let Some((id, client_id, sender, content)) = rows.try_next().await.map_err(db_error)? {
        let decoded = content
            .pointer("/blocks/0/text")
            .and_then(Value::as_str)
            .and_then(payload);
        let matches = id.to_string() == request_id
            || client_id.to_string() == request_id
            || format!("ios_{client_id}") == request_id
            || content
                .pointer("/canonical_history/local_message_id")
                .and_then(Value::as_str)
                == Some(request_id)
            || decoded
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                == Some(request_id);
        if !matches {
            continue;
        }
        let target_owner = decoded
            .as_ref()
            .and_then(|value| value.get("targetCloudAgentOwnerAccountId"))
            .and_then(Value::as_str);
        if target_owner != Some(owner)
            && !(kind.0 == "ai" && sender == owner && target_owner.is_none())
        {
            return Err(error(
                StatusCode::FORBIDDEN,
                "subsession_agent_owner_mismatch",
            ));
        }
        let agent_id = decoded
            .as_ref()
            .and_then(|value| value.get("targetCloudAgentId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("cloud-agent:{owner}"));
        if agent_id == format!("cloud-agent:{owner}") {
            return Ok(agent_id);
        }
        drop(rows);
        let definition: Option<(String, String)> = query_as("SELECT owner_account_id, access_scope FROM cloud_agent_definitions WHERE agent_id=$1 AND status='active'")
            .bind(&agent_id).fetch_optional(pool).await.map_err(db_error)?;
        if definition.is_some_and(|(account, scope)| {
            account == owner && (kind.0 == "ai" || scope == "participant_conversations")
        }) {
            return Ok(agent_id);
        }
        return Err(error(
            StatusCode::FORBIDDEN,
            "subsession_agent_owner_mismatch",
        ));
    }
    Err(error(
        StatusCode::NOT_FOUND,
        "subsession_parent_request_not_found",
    ))
}

async fn snapshot(
    pool: &PgPool,
    id: Uuid,
    account: &str,
    include_messages: bool,
) -> Result<Snapshot, ApiError> {
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        Value,
        String,
        String,
        String,
        Option<String>,
    );
    let row: Option<Row> = query_as(
        "SELECT sub.parent_session_id, sub.parent_request_id, sub.owner_account_id, sub.agent_id, sub.title, sub.status, sub.version, \
         CASE WHEN $3 THEN sub.messages ELSE '[]'::jsonb END, sub.updated_at::text, account.display_name, \
         COALESCE(definition.name, profile.display_name, 'Kordi'), \
         CASE WHEN sub.agent_id='cloud-agent:'||sub.owner_account_id THEN profile.avatar_url ELSE definition.avatar_url END FROM cloud_agent_subsessions sub \
         JOIN cloud_chat_conversation_members member ON member.conversation_id=sub.parent_conversation_id AND member.account_id=$2 AND member.membership_state='active' \
         JOIN cloud_accounts account ON account.account_id=sub.owner_account_id \
         LEFT JOIN cloud_default_agent_profiles profile ON profile.owner_account_id=sub.owner_account_id \
         LEFT JOIN cloud_agent_definitions definition ON definition.agent_id=sub.agent_id WHERE sub.subsession_id=$1"
    ).bind(id).bind(account).bind(include_messages).fetch_optional(pool).await.map_err(db_error)?;
    let Some((
        parent_session_id,
        parent_request_id,
        owner_account_id,
        agent_id,
        title,
        status,
        version,
        messages,
        updated_at,
        owner_display_name,
        name,
        agent_avatar_url,
    )) = row
    else {
        return Err(error(StatusCode::NOT_FOUND, "subsession_not_found"));
    };
    let agent_display_name = if agent_id == format!("cloud-agent:{owner_account_id}")
        && matches!(name.as_str(), "Kordi" | "My Kordi")
    {
        format!("{owner_display_name}'s Kordi")
    } else {
        name
    };
    let messages: Vec<Message> = serde_json::from_value(messages).map_err(db_error)?;
    // The initial task brief is written by the spawning Agent, even though its
    // runtime role is user. Private system context is not part of this snapshot.
    // Human follow-ups below retain their authenticated account attribution.
    let mut messages: Vec<Value> = messages
        .into_iter()
        .map(|message| {
            let mut value = json!(message);
            value["senderAgentId"] = json!(agent_id);
            value
        })
        .collect();
    if include_messages {
        messages.extend(conversation::messages(pool, id).await?);
    }
    let (activity, has_followup_execution, live, queued, started_at_ms): (Value, bool, bool, bool, Option<i64>) = query_as(
        "SELECT s.activity,
         EXISTS(SELECT 1 FROM cloud_agent_subsession_chat c JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id WHERE c.subsession_id=$1 AND r.status<>'queued'),
         s.status='running' AND (s.execution_backend='desktop' AND s.heartbeat_at>now()-interval '45 seconds' OR EXISTS(SELECT 1 FROM cloud_agent_fallback_runs r WHERE r.subsession_id=s.subsession_id AND r.status='running' AND r.lease_expires_at::timestamptz>now())),
         EXISTS(SELECT 1 FROM cloud_agent_fallback_runs r WHERE r.subsession_id=s.subsession_id AND r.status IN ('queued','leased')),
         (extract(epoch FROM s.execution_started_at)*1000)::bigint
         FROM cloud_agent_subsessions s WHERE s.subsession_id=$1")
        .bind(id).fetch_one(pool).await.map_err(db_error)?;
    let participants:Vec<(String,String,Option<String>,String)>=query_as("SELECT a.account_id,a.display_name,a.avatar_url,a.avatar_seed FROM cloud_agent_subsessions s JOIN cloud_chat_conversation_members m ON m.conversation_id=s.parent_conversation_id AND m.membership_state='active' JOIN cloud_accounts a ON a.account_id=m.account_id WHERE s.subsession_id=$1 ORDER BY a.account_id")
        .bind(id).fetch_all(pool).await.map_err(db_error)?;
    Ok(Snapshot {
        activity,
        has_followup_execution,
        live,
        queued,
        started_at_ms,
        participants: participants.into_iter().map(|(account_id,display_name,avatar_url,avatar_seed)|json!({"accountId":account_id,"displayName":display_name,"avatarUrl":avatar_url,"avatarSeed":avatar_seed})).collect(),
        session_id: id,
        parent_session_id,
        parent_request_id,
        owner_account_id,
        agent_id,
        owner_display_name,
        agent_display_name,
        agent_avatar_url,
        title,
        status,
        version,
        messages,
        updated_at,
    })
}

async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    Query(options): Query<ReadQuery>,
) -> Result<Json<Snapshot>, ApiError> {
    snapshot(
        state.db_pool(),
        id,
        &session.account_id,
        options.include_messages,
    )
    .await
    .map(Json)
}

async fn write(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    Json(request): Json<WriteRequest>,
) -> Result<Json<Snapshot>, ApiError> {
    if !validate(&request) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_subsession_snapshot",
        ));
    }
    let pool = state.db_pool();
    let mut transaction = pool.begin().await.map_err(db_error)?;
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *transaction)
        .await
        .map_err(db_error)?;
    let follow_started:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_subsession_chat c JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id JOIN cloud_agent_subsessions s ON s.subsession_id=c.subsession_id WHERE c.subsession_id=$1 AND s.owner_account_id=$2 AND r.status<>'queued')")
        .bind(id).bind(&session.account_id).fetch_one(&mut *transaction).await.map_err(db_error)?;
    if follow_started.0 {
        return snapshot(pool, id, &session.account_id, false)
            .await
            .map(Json);
    }
    let cloud_owned: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_subsessions WHERE subsession_id=$1 AND execution_backend='cloud')")
        .bind(id).fetch_one(pool).await.map_err(db_error)?;
    if cloud_owned.0 {
        return Err(error(StatusCode::FORBIDDEN, "subsession_runtime_mismatch"));
    }
    let parent = conversation_id_for_session(pool, &session.account_id, &request.parent_session_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::FORBIDDEN, "subsession_parent_forbidden"))?;
    let existing: Option<PublishedSubsessionRow> = query_as(
        "SELECT owner_account_id, publisher_device_id, parent_conversation_id, parent_request_id, agent_id, version, title, status, messages FROM cloud_agent_subsessions WHERE subsession_id=$1 FOR UPDATE"
    ).bind(id).fetch_optional(&mut *transaction).await.map_err(db_error)?;
    let messages = serde_json::to_value(&request.messages).map_err(db_error)?;
    if let Some((
        owner,
        _creator_device,
        conversation,
        parent_request,
        _agent,
        version,
        title,
        status,
        stored_messages,
    )) = existing
    {
        if _creator_device != session.device_id
            || owner != session.account_id
            || conversation != parent
            || parent_request != request.parent_request_id
        {
            return Err(error(
                StatusCode::FORBIDDEN,
                "subsession_identity_is_immutable",
            ));
        }
        if title != request.title || status != request.status || stored_messages != messages {
            if status == "stopped" && request.status != "stopped" {
                return Err(error(StatusCode::CONFLICT, "subsession_is_terminal"));
            }
            if status != "running" && request.status == "running" {
                return Err(error(StatusCode::CONFLICT, "subsession_is_terminal"));
            }
            if version != request.expected_version {
                return Err(error(StatusCode::CONFLICT, "subsession_version_conflict"));
            }
            query("UPDATE cloud_agent_subsessions SET title=$2, status=$3, messages=$4, execution_finished_at=CASE WHEN status='running' AND $3<>'running' THEN COALESCE((SELECT to_timestamp(max((m->>'timestampMs')::double precision)/1000) FROM jsonb_array_elements($4::jsonb) m WHERE m->>'role'='assistant' AND (m->>'timestampMs')::bigint>0),now()) ELSE execution_finished_at END, version=version+1, updated_at=now() WHERE subsession_id=$1")
                .bind(id).bind(&request.title).bind(&request.status).bind(messages).execute(&mut *transaction).await.map_err(db_error)?;
        }
    } else {
        if request.expected_version != 0 {
            return Err(error(StatusCode::CONFLICT, "subsession_version_conflict"));
        }
        let agent_id = request_agent(
            pool,
            parent,
            &request.parent_request_id,
            &session.account_id,
        )
        .await?;
        let changed = query("INSERT INTO cloud_agent_subsessions(subsession_id,parent_conversation_id,parent_session_id,parent_request_id,owner_account_id,publisher_device_id,agent_id,title,status,messages,execution_started_at,execution_finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE((SELECT to_timestamp(min((m->>'timestampMs')::double precision)/1000) FROM jsonb_array_elements($10::jsonb) m WHERE (m->>'timestampMs')::bigint>0),now()),CASE WHEN $9<>'running' THEN COALESCE((SELECT to_timestamp(max((m->>'timestampMs')::double precision)/1000) FROM jsonb_array_elements($10::jsonb) m WHERE m->>'role'='assistant' AND (m->>'timestampMs')::bigint>0),now()) END) ON CONFLICT DO NOTHING")
            .bind(id).bind(parent).bind(&request.parent_session_id).bind(&request.parent_request_id).bind(&session.account_id).bind(&session.device_id).bind(agent_id).bind(&request.title).bind(&request.status).bind(messages)
            .execute(&mut *transaction).await.map_err(db_error)?;
        if changed.rows_affected() != 1 {
            return Err(error(StatusCode::CONFLICT, "subsession_version_conflict"));
        }
    }
    let activity =
        crate::cloud_agent_runtime::subsession_execution::public_activity(&request.activity);
    query("UPDATE cloud_agent_subsessions SET execution_started_at=COALESCE(execution_started_at,(SELECT to_timestamp(min((m->>'timestampMs')::double precision)/1000) FROM jsonb_array_elements(messages) m WHERE (m->>'timestampMs')::bigint>0)),heartbeat_at=now(),activity=$2,version=version+CASE WHEN activity<>$2 THEN 1 ELSE 0 END WHERE subsession_id=$1")
        .bind(id).bind(activity).execute(&mut *transaction).await.map_err(db_error)?;
    transaction.commit().await.map_err(db_error)?;
    snapshot(pool, id, &session.account_id, false)
        .await
        .map(Json)
}
