use super::*;

pub(super) fn attach_cloud_scheduled_task_runtime(runtime: &mut DesktopRuntimeSession) {
    attach_cloud_scheduled_task_runtime_for_session(runtime, None);
}

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
            if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
                runtime.set_scheduled_tasks_cloud_runtime_for_session(
                    api_base,
                    session.token,
                    session_id.to_string(),
                );
            } else {
                runtime.set_scheduled_tasks_cloud_runtime(api_base, session.token);
            }
        }
        Ok(_) => {}
        Err(err) => eprintln!("Unable to load Cloud session for scheduled task runtime: {err}"),
    }
}
