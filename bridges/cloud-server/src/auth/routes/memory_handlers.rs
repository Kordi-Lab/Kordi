//! Account memory and replay state routes for the signed-in account (#1710).

use super::*;
use crate::memory_store::{
    self, MemoryEnvelope, SaveMemoryRequest, UpdateMemoryRequest, UpdateMemorySettingsRequest,
};

async fn audit(
    session: &CloudSession,
    state: &ServerState,
    event: &str,
    metadata: serde_json::Value,
) {
    if let Err(error) = write_audit(
        state.db_pool(),
        Some(&session.account_id),
        Some(&session.device_id),
        event,
        metadata,
    )
    .await
    {
        eprintln!("[memory] audit {event}: {error}");
    }
}

pub(super) async fn list_memories(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match memory_store::list(state.db_pool(), &session.account_id).await {
        Ok(list) => Json(list).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn save_memory(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<SaveMemoryRequest>,
) -> Response {
    let outcome = match memory_store::save(state.db_pool(), &session.account_id, &input).await {
        Ok(outcome) => outcome,
        Err(error) => return error.into_response(),
    };
    if let memory_store::SaveOutcome::Created(memory) = &outcome {
        audit(
            &session,
            &state,
            "memory_saved",
            serde_json::json!({
                "memoryId": memory.memory_id,
                "scope": memory.scope,
                "source": memory.source,
            }),
        )
        .await;
    }
    outcome.into_response()
}

pub(super) async fn update_memory(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(memory_id): axum::extract::Path<String>,
    Json(input): Json<UpdateMemoryRequest>,
) -> Response {
    match memory_store::update_text(
        state.db_pool(),
        &session.account_id,
        &memory_id,
        &input.text,
    )
    .await
    {
        Ok(memory) => {
            audit(
                &session,
                &state,
                "memory_updated",
                serde_json::json!({ "memoryId": memory.memory_id }),
            )
            .await;
            Json(MemoryEnvelope { memory }).into_response()
        }
        Err(error) => error.into_response(),
    }
}

pub(super) async fn delete_memory(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(memory_id): axum::extract::Path<String>,
) -> Response {
    match memory_store::archive(state.db_pool(), &session.account_id, &memory_id).await {
        Ok(()) => {
            audit(
                &session,
                &state,
                "memory_deleted",
                serde_json::json!({ "memoryId": memory_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => error.into_response(),
    }
}

pub(super) async fn forget_all_memories(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match memory_store::archive_all(state.db_pool(), &session.account_id).await {
        Ok(archived) => {
            audit(
                &session,
                &state,
                "memory_forget_all",
                serde_json::json!({ "archived": archived }),
            )
            .await;
            Json(serde_json::json!({ "archived": archived })).into_response()
        }
        Err(error) => error.into_response(),
    }
}

pub(super) async fn get_memory_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match memory_store::settings(state.db_pool(), &session.account_id).await {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn update_memory_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<UpdateMemorySettingsRequest>,
) -> Response {
    match memory_store::update_settings(state.db_pool(), &session.account_id, &input).await {
        Ok(settings) => {
            audit(
                &session,
                &state,
                "memory_settings_updated",
                serde_json::json!({
                    "memoryEnabled": settings.memory_enabled,
                    "excludeSensitive": settings.exclude_sensitive,
                }),
            )
            .await;
            Json(settings).into_response()
        }
        Err(error) => error.into_response(),
    }
}

pub(super) async fn get_omp_state_count(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match memory_store::omp_state_count(state.db_pool(), &session.account_id).await {
        Ok(count) => Json(serde_json::json!({ "runCount": count })).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn clear_omp_state(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match memory_store::clear_omp_state(state.db_pool(), &session.account_id).await {
        Ok(deleted) => {
            audit(
                &session,
                &state,
                "omp_state_cleared",
                serde_json::json!({ "deleted": deleted }),
            )
            .await;
            Json(serde_json::json!({ "deleted": deleted })).into_response()
        }
        Err(error) => error.into_response(),
    }
}
