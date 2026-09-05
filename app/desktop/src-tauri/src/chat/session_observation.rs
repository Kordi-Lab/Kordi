use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{ReadSessionRequest, SearchSessionsRequest, SessionObservationRuntime};
use std::sync::Arc;

pub(super) fn build_session_observation_runtime(
    session_id: Option<String>,
    directory: Option<String>,
) -> SessionObservationRuntime {
    let search_scope = session_id.clone();
    SessionObservationRuntime {
        search_sessions: Arc::new(move |request: SearchSessionsRequest| {
            let session_id = search_scope.clone();
            Box::pin(async move {
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
            Box::pin(async move {
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
        let runtime = build_session_observation_runtime(Some("group-a".to_string()), None);
        let result = (runtime.read_session)(ReadSessionRequest {
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
