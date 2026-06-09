use kordi_core::error::KordiError;
use kordi_tools::{ScheduleTaskRequest, ScheduleTaskResponse, ScheduleTaskRuntime};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskEnvelope {
    task: ScheduleTaskResponse,
}

pub fn build_scheduled_tasks_runtime(api_base: String, token: String) -> ScheduleTaskRuntime {
    let api_base = api_base.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    ScheduleTaskRuntime {
        schedule: Arc::new(move |request: ScheduleTaskRequest| {
            let api_base = api_base.clone();
            let token = token.clone();
            let client = client.clone();
            Box::pin(async move {
                let response = client
                    .post(format!("{api_base}/v1/cloud/scheduled-tasks"))
                    .bearer_auth(token)
                    .json(&request)
                    .send()
                    .await
                    .map_err(|err| KordiError::Tool(format!("send scheduled task request: {err}")))?;
                let status = response.status();
                if !status.is_success() {
                    let body = response.text().await.unwrap_or_default();
                    return Err(KordiError::Tool(format!("scheduled task request failed: {status} {body}"))); 
                }
                let envelope = response
                    .json::<ScheduledTaskEnvelope>()
                    .await
                    .map_err(|err| KordiError::Tool(format!("decode scheduled task response: {err}")))?;
                Ok(envelope.task)
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use anyhow::Result;
    use kordi_tools::{ScheduleTaskRequest, ScheduleTaskSchedule, ScheduleTaskTargetRuntime};
    use serde_json::json;

    use super::build_scheduled_tasks_runtime;

    #[tokio::test]
    async fn scheduled_tasks_runtime_posts_cloud_task_with_bearer_token() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let handle = thread::spawn(move || -> Result<String> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer)?;
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = r#"{"task":{"taskId":"scheduled_task_abc","title":"Check disk usage","status":"active","targetRuntime":"local_required","nextRunAt":"2026-06-09T12:00:00Z"}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            )?;
            Ok(request)
        });

        let runtime = build_scheduled_tasks_runtime(format!("http://{addr}"), "cloud-token".to_string());
        let response = (runtime.schedule)(ScheduleTaskRequest {
            title: "Check disk usage".to_string(),
            prompt: "Check local disk usage and report the result.".to_string(),
            schedule: ScheduleTaskSchedule::Once { at: "2026-06-09T12:00:00Z".to_string() },
            target_runtime: ScheduleTaskTargetRuntime::LocalRequired,
            tool_payload: json!({ "requiresLocalMac": true }),
        }).await?;

        let request = handle.join().expect("server thread should finish")?;
        assert!(request.starts_with("POST /v1/cloud/scheduled-tasks HTTP/1.1"));
        assert!(request.contains("authorization: Bearer cloud-token") || request.contains("Authorization: Bearer cloud-token"));
        assert!(request.contains("\"targetRuntime\":\"localRequired\""));
        assert!(request.contains("\"requiresLocalMac\":true"));
        assert_eq!(response.task_id, "scheduled_task_abc");
        assert_eq!(response.target_runtime, "local_required");
        Ok(())
    }
}
