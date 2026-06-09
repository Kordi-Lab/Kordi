use chrono::Local;
use kordi_core::error::KordiError;
use kordi_tools::{
    ScheduleTaskRequest, ScheduleTaskResponse, ScheduleTaskRuntime, ScheduleTaskSchedule,
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskEnvelope {
    task: ScheduleTaskResponse,
}

pub fn build_scheduled_tasks_runtime(api_base: String, token: String) -> ScheduleTaskRuntime {
    let local_offset_minutes = Local::now().offset().local_minus_utc() / 60;
    build_scheduled_tasks_runtime_with_session(api_base, token, local_offset_minutes, None)
}

pub fn build_scheduled_tasks_runtime_for_session(
    api_base: String,
    token: String,
    session_id: String,
) -> ScheduleTaskRuntime {
    let local_offset_minutes = Local::now().offset().local_minus_utc() / 60;
    build_scheduled_tasks_runtime_with_session(
        api_base,
        token,
        local_offset_minutes,
        Some(session_id),
    )
}

#[cfg(test)]
pub(crate) fn build_scheduled_tasks_runtime_with_local_offset(
    api_base: String,
    token: String,
    local_offset_minutes: i32,
) -> ScheduleTaskRuntime {
    build_scheduled_tasks_runtime_with_session(api_base, token, local_offset_minutes, None)
}

fn build_scheduled_tasks_runtime_with_session(
    api_base: String,
    token: String,
    local_offset_minutes: i32,
    session_id: Option<String>,
) -> ScheduleTaskRuntime {
    let api_base = api_base.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    ScheduleTaskRuntime {
        schedule: Arc::new(move |request: ScheduleTaskRequest| {
            let api_base = api_base.clone();
            let token = token.clone();
            let client = client.clone();
            let session_id = session_id.clone();
            Box::pin(async move {
                let request = normalize_request_for_cloud(
                    attach_session_id(request, session_id.as_deref()),
                    local_offset_minutes,
                );
                let response = client
                    .post(format!("{api_base}/v1/cloud/scheduled-tasks"))
                    .bearer_auth(token)
                    .json(&request)
                    .send()
                    .await
                    .map_err(|err| {
                        KordiError::Tool(format!("send scheduled task request: {err}"))
                    })?;
                let status = response.status();
                if !status.is_success() {
                    let body = response.text().await.unwrap_or_default();
                    return Err(KordiError::Tool(format!(
                        "scheduled task request failed: {status} {body}"
                    )));
                }
                let envelope = response
                    .json::<ScheduledTaskEnvelope>()
                    .await
                    .map_err(|err| {
                        KordiError::Tool(format!("decode scheduled task response: {err}"))
                    })?;
                Ok(envelope.task)
            })
        }),
    }
}

fn attach_session_id(
    mut request: ScheduleTaskRequest,
    session_id: Option<&str>,
) -> ScheduleTaskRequest {
    let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return request;
    };
    if !request.tool_payload.is_object() {
        request.tool_payload = serde_json::json!({});
    }
    if let Some(object) = request.tool_payload.as_object_mut() {
        object
            .entry("sessionId".to_string())
            .or_insert_with(|| serde_json::Value::String(session_id.to_string()));
    }
    request
}

fn normalize_request_for_cloud(
    mut request: ScheduleTaskRequest,
    local_offset_minutes: i32,
) -> ScheduleTaskRequest {
    if let ScheduleTaskSchedule::Daily { time, timezone } = &request.schedule {
        let timezone_value = timezone.as_deref().unwrap_or("local").trim();
        let looks_like_implicit_local = timezone_value.eq_ignore_ascii_case("local")
            || timezone_value.eq_ignore_ascii_case("system")
            || (timezone_value.eq_ignore_ascii_case("UTC")
                && !request_mentions_explicit_utc(&request));
        if looks_like_implicit_local {
            request.schedule = ScheduleTaskSchedule::Daily {
                time: local_wall_time_to_utc_time(time, local_offset_minutes),
                timezone: Some("UTC".to_string()),
            };
        }
    }
    request
}

fn request_mentions_explicit_utc(request: &ScheduleTaskRequest) -> bool {
    let text = format!("{}\n{}", request.title, request.prompt).to_ascii_lowercase();
    text.contains(" utc") || text.contains("utc ") || text.contains("gmt")
}

fn local_wall_time_to_utc_time(time: &str, local_offset_minutes: i32) -> String {
    let Some((hour, minute)) = parse_hh_mm(time) else {
        return time.to_string();
    };
    let local_minutes = hour * 60 + minute;
    let utc_minutes = (local_minutes - local_offset_minutes).rem_euclid(24 * 60);
    format!("{:02}:{:02}", utc_minutes / 60, utc_minutes % 60)
}

fn parse_hh_mm(value: &str) -> Option<(i32, i32)> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse::<i32>().ok()?;
    let minute = minute.parse::<i32>().ok()?;
    if (0..24).contains(&hour) && (0..60).contains(&minute) {
        Some((hour, minute))
    } else {
        None
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

    use super::{build_scheduled_tasks_runtime, build_scheduled_tasks_runtime_with_local_offset};

    #[tokio::test]
    async fn scheduled_tasks_runtime_converts_unqualified_daily_local_time_to_utc_before_posting()
    -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let handle = thread::spawn(move || -> Result<String> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer)?;
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = r#"{"task":{"taskId":"scheduled_task_news","title":"Summarize latest OpenAI news","status":"active","targetRuntime":"cloud","nextRunAt":"2026-06-09T05:30:00Z"}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            )?;
            Ok(request)
        });

        let runtime = build_scheduled_tasks_runtime_with_local_offset(
            format!("http://{addr}"),
            "cloud-token".to_string(),
            8 * 60,
        );
        let _response = (runtime.schedule)(ScheduleTaskRequest {
            title: "Summarize latest OpenAI news".to_string(),
            prompt: "Search the web for the latest OpenAI news every day at 13:30 and summarize it for me.".to_string(),
            schedule: ScheduleTaskSchedule::Daily { time: "13:30".to_string(), timezone: Some("UTC".to_string()) },
            target_runtime: ScheduleTaskTargetRuntime::Cloud,
            tool_payload: json!({}),
        }).await?;

        let request = handle.join().expect("server thread should finish")?;
        assert!(
            request.contains(
                "\"schedule\":{\"kind\":\"daily\",\"time\":\"05:30\",\"timezone\":\"UTC\"}"
            ),
            "request body should convert local 13:30 at UTC+8 to 05:30 UTC: {request}"
        );
        Ok(())
    }

    #[test]
    fn scheduled_tasks_runtime_preserves_explicit_utc_daily_time() {
        let request = ScheduleTaskRequest {
            title: "Summarize latest OpenAI news at 13:30 UTC".to_string(),
            prompt: "Search every day at 13:30 UTC.".to_string(),
            schedule: ScheduleTaskSchedule::Daily {
                time: "13:30".to_string(),
                timezone: Some("UTC".to_string()),
            },
            target_runtime: ScheduleTaskTargetRuntime::Cloud,
            tool_payload: json!({}),
        };

        let normalized = super::normalize_request_for_cloud(request, 8 * 60);
        assert_eq!(
            normalized.schedule,
            ScheduleTaskSchedule::Daily {
                time: "13:30".to_string(),
                timezone: Some("UTC".to_string())
            }
        );
    }

    #[tokio::test]
    async fn scheduled_tasks_runtime_attaches_originating_session_id() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let handle = thread::spawn(move || -> Result<String> {
            let (mut stream, _) = listener.accept()?;
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer)?;
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = r#"{"task":{"taskId":"scheduled_task_session","title":"Cloud check","status":"active","targetRuntime":"cloud","nextRunAt":"2026-06-09T05:30:00Z"}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            )?;
            Ok(request)
        });

        let runtime = super::build_scheduled_tasks_runtime_with_session(
            format!("http://{addr}"),
            "cloud-token".to_string(),
            0,
            Some("session:origin-chat".to_string()),
        );
        let _response = (runtime.schedule)(ScheduleTaskRequest {
            title: "Cloud check".to_string(),
            prompt: "Run in cloud.".to_string(),
            schedule: ScheduleTaskSchedule::Daily {
                time: "05:30".to_string(),
                timezone: Some("UTC".to_string()),
            },
            target_runtime: ScheduleTaskTargetRuntime::Cloud,
            tool_payload: json!({}),
        })
        .await?;

        let request = handle.join().expect("server thread should finish")?;
        assert!(
            request.contains("\"sessionId\":\"session:origin-chat\""),
            "request body should include originating chat session id: {request}"
        );
        Ok(())
    }

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

        let runtime =
            build_scheduled_tasks_runtime(format!("http://{addr}"), "cloud-token".to_string());
        let response = (runtime.schedule)(ScheduleTaskRequest {
            title: "Check disk usage".to_string(),
            prompt: "Check local disk usage and report the result.".to_string(),
            schedule: ScheduleTaskSchedule::Once {
                at: "2026-06-09T12:00:00Z".to_string(),
            },
            target_runtime: ScheduleTaskTargetRuntime::LocalRequired,
            tool_payload: json!({ "requiresLocalMac": true }),
        })
        .await?;

        let request = handle.join().expect("server thread should finish")?;
        assert!(request.starts_with("POST /v1/cloud/scheduled-tasks HTTP/1.1"));
        assert!(
            request.contains("authorization: Bearer cloud-token")
                || request.contains("Authorization: Bearer cloud-token")
        );
        assert!(request.contains("\"targetRuntime\":\"localRequired\""));
        assert!(request.contains("\"requiresLocalMac\":true"));
        assert_eq!(response.task_id, "scheduled_task_abc");
        assert_eq!(response.target_runtime, "local_required");
        Ok(())
    }
}
