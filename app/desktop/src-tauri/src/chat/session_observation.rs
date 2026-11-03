use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{ReadSessionRequest, SearchSessionsRequest, SessionObservationRuntime};
use std::sync::Arc;
pub(super) mod cloud;
pub(super) mod image_visibility;
pub(super) mod selection;

#[cfg(test)]
pub(super) fn build_session_observation_runtime(
    session_id: Option<String>,
    directory: Option<String>,
    calendar: Option<kordi_tools::calendar::CalendarRuntime>,
) -> SessionObservationRuntime {
    build_with_identity(session_id, directory, calendar, None)
}

pub(super) fn build_with_identity(
    session_id: Option<String>,
    directory: Option<String>,
    calendar: Option<kordi_tools::calendar::CalendarRuntime>,
    identity: Option<kordi_cli::desktop_runtime::DesktopChatContextMessage>,
) -> SessionObservationRuntime {
    let search_scope = session_id.clone();
    let search_identity = identity.clone();
    SessionObservationRuntime {
        calendar,
        search_sessions: Arc::new(move |request: SearchSessionsRequest| {
            let session_id = search_scope.clone();
            let identity = search_identity.clone();
            Box::pin(async move {
                if let Some(scope) = session_id.as_deref() {
                    if let Some(remote) = cloud::member_runtime(scope, identity.as_ref())? {
                        return (remote.search_sessions)(request).await;
                    }
                } else if let Some(owner) = cloud::catalog::owner_catalog(identity.as_ref())? {
                    let conversations = owner.conversations().await?;
                    let mut sessions = cloud::catalog::search(&conversations, &request);
                    let limit = request.limit.unwrap_or(8).clamp(1, 20);
                    let local = run_blocking_observation(move || {
                        crate::canonical_sessions::session_observation::search_local_sessions_for_observation(request)
                    })
                    .await?;
                    sessions.extend(local.sessions);
                    sessions.truncate(limit);
                    return Ok(kordi_tools::SearchSessionsResponse {
                        sessions,
                        next_before_sequence: None,
                    });
                }
                run_blocking_observation(move || {
                    crate::canonical_sessions::search_sessions_for_observation_scoped(
                        request,
                        session_id.as_deref(),
                    )
                })
                .await
            })
        }),
        read_session: Arc::new(move |request: ReadSessionRequest| {
            let scope = session_id.clone();
            let directory = directory.clone();
            let identity = identity.clone();
            Box::pin(async move {
                if scope
                    .as_deref()
                    .is_some_and(|id| id != request.session_id.trim())
                {
                    return Err(KordiError::Tool(
                        "This agent can only read its current group conversation".into(),
                    ));
                }
                if scope.is_none() {
                    if let Some(owner) = cloud::catalog::owner_catalog(identity.as_ref())? {
                        if let Some(response) = owner.read(request.clone()).await? {
                            return Ok(response);
                        }
                        if is_synced_session(&request.session_id)? {
                            return Err(KordiError::Tool(
                                "Conversation is no longer accessible".into(),
                            ));
                        }
                    }
                }
                if let Some(remote) = cloud::member_runtime(&request.session_id, identity.as_ref())?
                {
                    return (remote.read_session)(request).await;
                }
                run_blocking_observation(move || {
                    if scope
                        .as_deref()
                        .is_some_and(|id| id != request.session_id.trim())
                    {
                        return Err(
                            "This agent can only read its current group conversation".to_string()
                        );
                    }
                    let include_directory = request.mode.as_deref() == Some("participants");
                    let mut response =
                        crate::canonical_sessions::read_session_for_observation(request)?;
                    if include_directory {
                        response.directory = directory;
                    }
                    Ok(response)
                })
                .await
            })
        }),
    }
}

// Shared conversations must never fall back to a possibly stale local transcript.
fn is_synced_session(session_id: &str) -> KordiResult<bool> {
    let conn = crate::canonical_sessions::open_db().map_err(KordiError::Tool)?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_sync_conversations WHERE client_session_id=?1)
            OR EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND kind IN ('group','direct'))",
        [session_id.trim()],
        |row| row.get(0),
    )
    .map_err(|error| KordiError::Tool(error.to_string()))
}

async fn run_blocking_observation<T, F>(operation: F) -> KordiResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|err| KordiError::Tool(format!("session observation task failed: {err}")))?
        .map_err(KordiError::Tool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn group_context_cannot_read_another_session() {
        let runtime = build_session_observation_runtime(Some("group-a".to_string()), None, None);
        let result = (runtime.read_session)(ReadSessionRequest {
            before_sequence: None,
            attachment_id: None,
            expected_version: None,
            offset: None,
            session_id: "private-session".to_string(),
            around_message_id: None,
            limit: None,
            mode: None,
            message_ids: None,
        })
        .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("only read its current group"));
    }
}
