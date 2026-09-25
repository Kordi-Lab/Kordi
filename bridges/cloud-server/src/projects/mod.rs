//! Private project discovery and bounded, account-owned desktop operations.
//! Only opaque project IDs and display names cross the device boundary.
use crate::{
    auth::routes::{cloud_session_middleware, CloudSession},
    server::ServerState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub sessions: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Publish {
    projects: Vec<Project>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    command_id: Uuid,
    device_id: String,
    action: String,
    project_id: Option<String>,
    session_id: Option<String>,
    repository: Option<String>,
    page: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    result: Value,
    failed: bool,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/projects", get(catalog).put(publish))
        .route("/v1/cloud/projects/heartbeat", post(heartbeat))
        .route("/v1/cloud/projects/commands", post(enqueue))
        .route("/v1/cloud/projects/commands/next", post(next))
        .route("/v1/cloud/projects/commands/:id", get(status).put(complete))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}
fn error(code: StatusCode, message: &str) -> Response {
    (
        code,
        Json(json!({"errorCode":"project_unavailable","message":message})),
    )
        .into_response()
}
fn database_error(_: sqlx_core::Error) -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not synchronize projects. Try again.",
    )
}
async fn desktop(pool: &PgPool, session: &CloudSession) -> Result<bool, sqlx_core::Error> {
    let row: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_devices WHERE device_id=$1 AND account_id=$2 AND device_platform IN ('macos','desktop') AND revoked_at IS NULL)")
        .bind(&session.device_id).bind(&session.account_id).fetch_one(pool).await?;
    Ok(row.0)
}
async fn heartbeat(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match query(
        "UPDATE cloud_project_devices SET updated_at=now() WHERE device_id=$1 AND account_id=$2",
    )
    .bind(&session.device_id)
    .bind(&session.account_id)
    .execute(state.db_pool())
    .await
    {
        Ok(_) => Json(json!({"ok":true})).into_response(),
        Err(e) => database_error(e),
    }
}
type DeviceCatalogRow = (String, Option<String>, Value, bool);

async fn catalog(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Result<Vec<DeviceCatalogRow>, _> = query_as("SELECT p.device_id,d.device_name,p.projects,p.updated_at>now()-interval '25 seconds' FROM cloud_project_devices p JOIN cloud_devices d USING(device_id) WHERE p.account_id=$1 AND d.revoked_at IS NULL ORDER BY p.device_id")
        .bind(&session.account_id).fetch_all(state.db_pool()).await;
    match rows {
        Ok(rows) => Json(json!({"devices":rows.into_iter().map(|(id,name,projects,online)|json!({"id":id,"name":name.unwrap_or_else(||"Mac".into()),"projects":projects,"online":online})).collect::<Vec<_>>()})).into_response(),
        Err(e) => database_error(e),
    }
}
async fn publish(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<Publish>,
) -> Response {
    if !desktop(state.db_pool(), &session).await.unwrap_or(false) {
        return error(
            StatusCode::FORBIDDEN,
            "Only an authorized Mac can publish its projects.",
        );
    }
    if input.projects.len() > 200
        || input.projects.iter().any(|p| {
            p.id.len() != 64
                || !p.id.bytes().all(|b| b.is_ascii_hexdigit())
                || p.name.is_empty()
                || p.name.len() > 200
                || p.sessions.len() > 2000
                || p.sessions.iter().any(|s| s.is_empty() || s.len() > 256)
        })
    {
        return error(StatusCode::BAD_REQUEST, "Invalid project catalog.");
    }
    match query("INSERT INTO cloud_project_devices(device_id,account_id,projects) VALUES($1,$2,$3) ON CONFLICT(device_id) DO UPDATE SET projects=$3,updated_at=now()")
        .bind(&session.device_id).bind(&session.account_id).bind(json!(input.projects)).execute(state.db_pool()).await {
        Ok(_) => Json(json!({"ok":true})).into_response(), Err(e)=>database_error(e),
    }
}
async fn enqueue(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<Command>,
) -> Response {
    if !["repositories", "importFolder", "cloneRepository", "assign"]
        .contains(&input.action.as_str())
        || input.repository.as_ref().is_some_and(|r| r.len() > 200)
        || input.session_id.as_ref().is_some_and(|s| s.len() > 256)
    {
        return error(StatusCode::BAD_REQUEST, "Invalid project action.");
    }
    let request = json!({"action":input.action,"projectId":input.project_id,"sessionId":input.session_id,"repository":input.repository,"page":input.page});
    let result = async {
        let mut tx=state.db_pool().begin().await?;
        let ready:Option<(Value,)> = query_as("SELECT p.projects FROM cloud_project_devices p JOIN cloud_devices d USING(device_id) WHERE p.device_id=$1 AND p.account_id=$2 AND d.revoked_at IS NULL AND p.updated_at>now()-interval '25 seconds' FOR UPDATE OF p")
            .bind(&input.device_id).bind(&session.account_id).fetch_optional(&mut *tx).await?;
        let Some((projects,))=ready else {return Ok::<_,sqlx_core::Error>(false)};
        if let Some(id)=input.project_id.as_ref() {
            if !projects.as_array().is_some_and(|rows|rows.iter().any(|p|p["id"].as_str()==Some(id))) {return Ok(false)}
        }
        if let Some(id)=input.session_id.as_ref().filter(|id|!id.is_empty()) {
            let owns:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_chat_conversations c JOIN cloud_chat_conversation_members m USING(conversation_id) WHERE c.legacy_session_id=$1 AND c.kind='ai' AND m.account_id=$2 AND m.membership_state='active')")
                .bind(id).bind(&session.account_id).fetch_one(&mut *tx).await?;
            if !owns.0 {return Ok(false)}
            let active:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs WHERE session_id=$1 AND status IN ('queued','leased','running'))")
                .bind(id).fetch_one(&mut *tx).await?;
            if active.0 {return Ok(false)}
            if session_device(state.db_pool(), &session.account_id, id).await?.is_some_and(|device|device!=input.device_id) {return Ok(false)}
        }
        let pending:(i64,)=query_as("SELECT count(*) FROM cloud_project_commands WHERE device_id=$1 AND status IN ('queued','running') AND created_at>now()-interval '12 minutes'")
            .bind(&input.device_id).fetch_one(&mut *tx).await?;
        if pending.0>=10 {return Ok(false)}
        query("INSERT INTO cloud_project_commands(command_id,account_id,device_id,request) VALUES($1,$2,$3,$4) ON CONFLICT(command_id) DO NOTHING")
            .bind(input.command_id).bind(&session.account_id).bind(&input.device_id).bind(request).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }.await;
    match result {Ok(true)=>Json(json!({"id":input.command_id,"status":"queued"})).into_response(),Ok(false)=>error(StatusCode::CONFLICT,"Open Kordi on the project Mac and try again. The project or session may no longer be available."),Err(e)=>database_error(e)}
}
async fn next(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    if !desktop(state.db_pool(), &session).await.unwrap_or(false) {
        return error(StatusCode::FORBIDDEN, "A project Mac is required.");
    }
    let result:Result<Option<(Uuid,Value)>,_>=query_as("UPDATE cloud_project_commands SET status='running',updated_at=now() WHERE command_id=(SELECT command_id FROM cloud_project_commands WHERE device_id=$1 AND account_id=$2 AND status='queued' AND created_at>now()-interval '2 minutes' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING command_id,request")
        .bind(&session.device_id).bind(&session.account_id).fetch_optional(state.db_pool()).await;
    match result {
        Ok(row) => {
            Json(json!({"command":row.map(|(id,request)|json!({"id":id,"request":request}))}))
                .into_response()
        }
        Err(e) => database_error(e),
    }
}
async fn status(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
) -> Response {
    let result:Result<Option<(String,Option<Value>,bool)>,_>=query_as("SELECT status,result,created_at<now()-interval '12 minutes' FROM cloud_project_commands WHERE command_id=$1 AND account_id=$2")
        .bind(id).bind(&session.account_id).fetch_optional(state.db_pool()).await;
    match result {Ok(Some((status,result,expired)))=>Json(json!({"id":id,"status":if expired && (status=="queued" || status=="running") {"failed"} else {&status},"result":result})).into_response(),Ok(None)=>error(StatusCode::NOT_FOUND,"Project action not found."),Err(e)=>database_error(e)}
}
async fn complete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    Json(input): Json<Completion>,
) -> Response {
    if input.result.to_string().len() > 100_000 {
        return error(StatusCode::BAD_REQUEST, "Project result is too large.");
    }
    match query("UPDATE cloud_project_commands SET status=$4,result=$5,updated_at=now() WHERE command_id=$1 AND account_id=$2 AND device_id=$3 AND status='running'")
        .bind(id).bind(&session.account_id).bind(&session.device_id).bind(if input.failed {"failed"} else {"completed"}).bind(input.result).execute(state.db_pool()).await {
        Ok(result) if result.rows_affected()==1 => Json(json!({"ok":true})).into_response(),Ok(_)=>error(StatusCode::CONFLICT,"Project action is no longer active."),Err(e)=>database_error(e),
    }
}

pub async fn session_device(
    pool: &PgPool,
    account: &str,
    session: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row:Option<(String,)> = query_as("SELECT p.device_id FROM cloud_project_devices p, jsonb_array_elements(p.projects) project WHERE p.account_id=$1 AND (project->'sessions') ? $2 ORDER BY p.updated_at DESC LIMIT 1")
        .bind(account).bind(session).fetch_optional(pool).await?;
    Ok(row.map(|r| r.0))
}

/// A project can wait for its Mac, but can never fall back to a different filesystem.
pub async fn cloud_execution_gate(pool: &PgPool, account: &str, session: &str) -> Option<Response> {
    let device = match session_device(pool, account, session).await {
        Ok(Some(device)) => device,
        Ok(None) => return None,
        Err(error) => return Some(database_error(error)),
    };
    let online: Result<(bool,), _> = query_as("SELECT EXISTS(SELECT 1 FROM cloud_project_devices p JOIN cloud_devices d USING(device_id) WHERE p.device_id=$1 AND d.revoked_at IS NULL AND p.updated_at>now()-interval '25 seconds')")
        .bind(device).fetch_one(pool).await;
    Some(match online {
        Ok((true,)) => (StatusCode::CONFLICT, Json(json!({"errorCode":"owner_online","message":"The project Mac will handle this task."}))).into_response(),
        Ok((false,)) => (StatusCode::CONFLICT, Json(json!({"errorCode":"project_mac_offline","message":"Open Kordi on the project Mac to run this task."}))).into_response(),
        Err(error) => database_error(error),
    })
}
