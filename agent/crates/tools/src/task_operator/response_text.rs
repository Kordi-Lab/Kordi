use super::models::TaskOperatorRuntimeResponse;

pub(super) fn runtime_response_text(response: &TaskOperatorRuntimeResponse) -> String {
    let mut text = response
        .message
        .clone()
        .or_else(|| {
            response
                .target
                .as_ref()
                .map(|target| format!("Task {target}: {}", response.status))
        })
        .unwrap_or_else(|| format!("Task operator status: {}", response.status));

    if let Some(session) = &response.background_session {
        let encoded = serde_json::to_string(session).unwrap_or_default();
        text.push_str("\n\nBackground session: ");
        text.push_str(&encoded);
    }

    if !response.tasks.is_empty() {
        text.push_str("\n\nTasks:");
        for task in response.tasks.iter().take(50) {
            text.push_str(&format!(
                "\n- ID: `{}`; title: {}; status: {}",
                task.path, task.title, task.status,
            ));
            if let Some(parent_task_id) = task
                .parent_task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                text.push_str(&format!("; parent: `{parent_task_id}`"));
            }
            if let Some(summary) = task
                .summary
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                text.push_str(&format!("; summary: {summary}"));
            }
        }
        if response.tasks.len() > 50 {
            text.push_str(&format!("\n- … {} more task(s)", response.tasks.len() - 50));
        }
    }

    text
}
