use super::{model, store, SimulatorService};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use kordi_human_simulator::{config::ActorConfig, decision::Decision, protocol::*};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(super) struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx_core::Error> for ApiError {
    fn from(_: sqlx_core::Error) -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, "state_unavailable")
    }
}
type ApiResult<T> = Result<Json<T>, ApiError>;
fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "ownership_or_revision_conflict")
}
fn bad() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "invalid_request")
}
pub(super) fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() >= 32 && v.len() <= 1024)
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "unauthorized"))
}
fn operator(service: &SimulatorService, headers: &HeaderMap) -> Result<(), ApiError> {
    let hash = digest(bearer(headers)?);
    let diff = hash
        .bytes()
        .zip(service.operator_hash.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if diff != 0 || hash.len() != service.operator_hash.len() {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(())
}
async fn worker(service: &SimulatorService, headers: &HeaderMap, id: &str) -> Result<(), ApiError> {
    if !store::authorized(&service.pool, id, &digest(bearer(headers)?)).await? {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(())
}
fn view(service: &SimulatorService, row: store::ActorRecord) -> Result<ActorView, ApiError> {
    Ok(ActorView {
        config: serde_json::from_value(row.config).map_err(|_| bad())?,
        state: serde_json::from_value(row.state).map_err(|_| bad())?,
        revision: row.revision,
        generation: row.generation,
        model_calls: row.model_calls,
        messages_sent: row.messages_sent,
        kordi_api_base: service.kordi_api_base.clone(),
    })
}
async fn current(service: &SimulatorService, id: &str) -> Result<ActorView, ApiError> {
    view(
        service,
        store::get(&service.pool, id)
            .await?
            .ok_or(ApiError(StatusCode::NOT_FOUND, "actor_not_found"))?,
    )
}

pub(super) async fn ready(State(service): State<SimulatorService>) -> ApiResult<Value> {
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        sqlx_core::query::query("SELECT 1").execute(&service.pool),
    )
    .await
    .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "state_unavailable"))??;
    Ok(Json(json!({"status":"ready"})))
}

pub(super) async fn create(
    State(service): State<SimulatorService>,
    headers: HeaderMap,
    Json(config): Json<ActorConfig>,
) -> ApiResult<Value> {
    operator(&service, &headers)?;
    config.validate().map_err(|_| bad())?;
    if !service.allowed_accounts.contains(&config.account_id) {
        return Err(ApiError(StatusCode::FORBIDDEN, "account_not_allowed"));
    }
    let value = serde_json::to_value(&config).map_err(|_| bad())?;
    if value.to_string().len() > 32 * 1024 {
        return Err(bad());
    }
    let token = format!("sim_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let state = serde_json::to_value(ActorState::default()).map_err(|_| bad())?;
    if !store::create(
        &service.pool,
        &config.actor_id,
        &value,
        &state,
        &digest(&token),
    )
    .await?
    {
        return Err(ApiError(StatusCode::CONFLICT, "actor_exists"));
    }
    Ok(Json(
        json!({"actor_id":config.actor_id,"worker_token":token}),
    ))
}

pub(super) async fn status(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Value> {
    if operator(&service, &headers).is_err() {
        worker(&service, &headers, &id).await?;
    }
    let record = current(&service, &id).await?;
    Ok(Json(
        json!({"status":record.state.status,"model_calls":record.model_calls,"messages_sent":record.messages_sent,
        "pending_send":record.state.pending.is_some(),"revision":record.revision,"last_error":record.state.last_error,"wake_at":record.state.wake_at}),
    ))
}
pub(super) async fn stop(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Value> {
    operator(&service, &headers)?;
    if !store::stop(&service.pool, &id).await? {
        return Err(ApiError(StatusCode::NOT_FOUND, "actor_not_found"));
    }
    Ok(Json(json!({"status":"stopped"})))
}
pub(super) async fn lease(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<LeaseRequest>,
) -> ApiResult<ActorView> {
    worker(&service, &headers, &id).await?;
    let row = store::lease(&service.pool, &id, &request.owner.to_string())
        .await?
        .ok_or_else(conflict)?;
    Ok(Json(view(&service, row)?))
}
pub(super) async fn heartbeat(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<OwnedRequest>,
) -> ApiResult<Value> {
    worker(&service, &headers, &id).await?;
    if !store::heartbeat(
        &service.pool,
        &id,
        &request.owner.to_string(),
        request.generation,
    )
    .await?
    {
        return Err(conflict());
    }
    Ok(Json(json!({"renewed":true})))
}
pub(super) async fn release(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<OwnedRequest>,
) -> ApiResult<Value> {
    worker(&service, &headers, &id).await?;
    if !store::release(
        &service.pool,
        &id,
        &request.owner.to_string(),
        request.generation,
    )
    .await?
    {
        return Err(conflict());
    }
    Ok(Json(json!({"released":true})))
}

pub(super) async fn checkpoint(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CheckpointRequest>,
) -> ApiResult<ActorView> {
    worker(&service, &headers, &id).await?;
    request.state.validate().map_err(|_| bad())?;
    let existing = current(&service, &id).await?;
    // Workers may checkpoint observations, but cannot erase a pending send or alter model memory/decisions.
    if request.state.pending != existing.state.pending
        || request.state.memory != existing.state.memory
        || request.state.status != existing.state.status
        || request.state.wake_at != existing.state.wake_at
        || request.state.failures != existing.state.failures
        || request.state.last_error != existing.state.last_error
    {
        return Err(bad());
    }
    if !store::save(
        &service.pool,
        &id,
        &request.owner.to_string(),
        request.generation,
        request.revision,
        &serde_json::to_value(request.state).map_err(|_| bad())?,
    )
    .await?
    {
        return Err(conflict());
    }
    Ok(Json(current(&service, &id).await?))
}

pub(super) async fn decide(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<DecisionRequest>,
) -> ApiResult<ActorView> {
    worker(&service, &headers, &id).await?;
    let _slot = service
        .model_slots
        .try_acquire()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "model_capacity_reached"))?;
    let mut snapshot = current(&service, &id).await?;
    if snapshot.state.pending.is_some() || !snapshot.state.initialized {
        return Err(conflict());
    }
    let due = snapshot.state.wake_at.is_some_and(|at| at <= Utc::now());
    if !snapshot.state.needs_decision && !due {
        return Err(conflict());
    }
    if snapshot.model_calls >= snapshot.config.max_model_calls as i32
        || snapshot.messages_sent >= snapshot.config.max_messages as i32
    {
        snapshot.state.status = "stopped".into();
        snapshot.state.last_error = Some("budget_exhausted".into());
        if !store::save(
            &service.pool,
            &id,
            &request.owner.to_string(),
            request.generation,
            request.revision,
            &serde_json::to_value(snapshot.state).map_err(|_| bad())?,
        )
        .await?
        {
            return Err(conflict());
        }
        return Ok(Json(current(&service, &id).await?));
    }
    let reserved = store::reserve_model(
        &service.pool,
        &id,
        &request.owner.to_string(),
        request.generation,
        request.revision,
        snapshot.config.max_model_calls as i32,
    )
    .await?
    .ok_or_else(conflict)?;
    let revision = reserved.revision;
    snapshot = view(&service, reserved)?;
    let outcome = model::decide(&service.provider, &snapshot.config, &snapshot.state).await;
    snapshot.state.needs_decision = false;
    snapshot.state.wake_at = None;
    match outcome {
        Ok(decision) => {
            snapshot.state.failures = 0;
            snapshot.state.last_error = None;
            snapshot.state.memory = decision.memory().to_string();
            match decision {
                Decision::Send { text, .. } => {
                    snapshot.state.pending = Some(PendingSend {
                        client_message_id: Uuid::new_v4(),
                        text,
                    })
                }
                Decision::Wait { seconds, .. } => {
                    snapshot.state.wake_at = Some(Utc::now() + Duration::seconds(seconds as i64))
                }
                Decision::Finish { .. } => snapshot.state.status = "finished".into(),
            }
        }
        Err(_) => {
            snapshot.state.failures += 1;
            snapshot.state.last_error = Some("model_attempt_failed".into());
            if snapshot.state.failures >= 3 {
                snapshot.state.status = "stopped".into();
            } else {
                snapshot.state.wake_at =
                    Some(Utc::now() + Duration::seconds(15 * (1_i64 << snapshot.state.failures)));
            }
        }
    }
    if !store::save(
        &service.pool,
        &id,
        &request.owner.to_string(),
        request.generation,
        revision,
        &serde_json::to_value(snapshot.state).map_err(|_| bad())?,
    )
    .await?
    {
        return Err(conflict());
    }
    Ok(Json(current(&service, &id).await?))
}

pub(super) async fn confirm(
    State(service): State<SimulatorService>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ConfirmRequest>,
) -> ApiResult<ActorView> {
    worker(&service, &headers, &id).await?;
    let mut snapshot = current(&service, &id).await?;
    if snapshot
        .state
        .pending
        .as_ref()
        .is_none_or(|p| p.client_message_id != request.client_message_id)
    {
        return Err(conflict());
    }
    snapshot.state.pending = None;
    if !store::confirm_message(
        &service.pool,
        &id,
        &request.owner.to_string(),
        request.generation,
        request.revision,
        &serde_json::to_value(snapshot.state).map_err(|_| bad())?,
        snapshot.config.max_messages as i32,
    )
    .await?
    {
        return Err(conflict());
    }
    Ok(Json(current(&service, &id).await?))
}
