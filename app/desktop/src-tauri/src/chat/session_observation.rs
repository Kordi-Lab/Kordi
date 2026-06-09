use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{ReadSessionRequest, SearchSessionsRequest, SessionObservationRuntime};
use std::sync::Arc;

pub(super) fn build_session_observation_runtime() -> SessionObservationRuntime {
    SessionObservationRuntime {
        search_sessions: Arc::new(|request: SearchSessionsRequest| {
            Box::pin(async move {
                run_blocking_observation(move || {
                    crate::canonical_sessions::search_sessions_for_observation(request)
                })
                .await
            })
        }),
        read_session: Arc::new(|request: ReadSessionRequest| {
            Box::pin(async move {
                run_blocking_observation(move || {
                    crate::canonical_sessions::read_session_for_observation(request)
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
        .map_err(|err| KordiError::Tool(err))
}
