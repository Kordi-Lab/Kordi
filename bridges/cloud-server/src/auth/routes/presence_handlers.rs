use super::*;

pub(super) async fn publish_presence_change_if_needed(
    state: &Arc<ServerState>,
    account_id: &str,
    before: crate::presence::AccountPresenceStatus,
    after: crate::presence::AccountPresenceStatus,
) {
    if before == after {
        return;
    }
    let _ = crate::presence::publish_presence_to_observers(
        state.db_pool(),
        state.events(),
        account_id,
        after,
    )
    .await;
}

pub(super) async fn publish_current_device_online(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let before = crate::presence::account_presence_status(
        state.db_pool(),
        &session.account_id,
        Utc::now(),
        crate::presence::presence_timeout(),
    )
    .await
    .map(|summary| summary.status)
    .unwrap_or(crate::presence::AccountPresenceStatus::Offline);
    match crate::presence::mark_device_online(
        state.db_pool(),
        &session.account_id,
        &session.device_id,
    )
    .await
    {
        Ok(summary) => {
            publish_presence_change_if_needed(&state, &session.account_id, before, summary.status)
                .await;
            Json(summary).into_response()
        }
        Err(_) => err(
            "server_error",
            "Could not update presence.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(super) async fn publish_current_device_heartbeat(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    publish_current_device_online(State(state), Extension(session)).await
}

pub(super) async fn publish_current_device_offline(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let before = crate::presence::account_presence_status(
        state.db_pool(),
        &session.account_id,
        Utc::now(),
        crate::presence::presence_timeout(),
    )
    .await
    .map(|summary| summary.status)
    .unwrap_or(crate::presence::AccountPresenceStatus::Offline);
    match crate::presence::mark_device_offline(
        state.db_pool(),
        &session.account_id,
        &session.device_id,
    )
    .await
    {
        Ok(summary) => {
            publish_presence_change_if_needed(&state, &session.account_id, before, summary.status)
                .await;
            Json(summary).into_response()
        }
        Err(_) => err(
            "server_error",
            "Could not update presence.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(super) async fn list_contact_presence(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match crate::presence::contact_presence_summaries(state.db_pool(), &session.account_id).await {
        Ok(accounts) => Json(PresenceContactsResponse { accounts }).into_response(),
        Err(_) => err(
            "server_error",
            "Could not load presence.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
