use super::*;

pub(super) fn attach_cloud_scheduled_task_runtime(runtime: &mut DesktopRuntimeSession) {
    attach_cloud_scheduled_task_runtime_for_session(runtime, None);
}

/// Attaches the `schedule_task` runtime for the signed-in account. The
/// runtime keeps the account, not its access token: browser sign-in tokens
/// expire after an hour, so each request resolves a current token and
/// refreshes it when needed.
pub(super) fn attach_cloud_scheduled_task_runtime_for_session(
    runtime: &mut DesktopRuntimeSession,
    session_id: Option<&str>,
) {
    match crate::cloud_session::cloud_session_load() {
        Ok(Some(session)) if !session.token.trim().is_empty() => {
            let api_base = match crate::cloud_api_base_url_from_env() {
                Ok(value) => value,
                Err(err) => {
                    eprintln!(
                        "Unable to attach Cloud scheduled task runtime because the API base is unsafe: {err}"
                    );
                    return;
                }
            };
            let session_id = session_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| runtime.session_id())
                .to_string();
            runtime.set_scheduled_tasks_runtime(fresh_token_runtime(
                api_base,
                session.account_id,
                session_id,
            ));
        }
        Ok(_) => {}
        Err(err) => eprintln!("Unable to load Cloud session for scheduled task runtime: {err}"),
    }
}

fn fresh_token_runtime(
    api_base: String,
    account_id: String,
    session_id: String,
) -> kordi_tools::ScheduleTaskRuntime {
    kordi_tools::ScheduleTaskRuntime {
        schedule: std::sync::Arc::new(move |request| {
            let (api_base, account_id, session_id) =
                (api_base.clone(), account_id.clone(), session_id.clone());
            Box::pin(async move {
                let token = crate::cloud_session_refresh::fresh_token_for(&account_id)
                    .await
                    .ok_or_else(|| {
                        kordi_core::error::KordiError::Tool(
                            "Sign in to Kordi with the account that started this session to schedule tasks."
                                .into(),
                        )
                    })?;
                let runtime =
                    kordi_cli::scheduled_tasks_runtime::build_scheduled_tasks_runtime_for_session(
                        api_base, token, session_id,
                    );
                (runtime.schedule)(request).await
            })
        }),
    }
}
