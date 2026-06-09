use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    ReadSessionRequest, SearchSessionsRequest, Tool, ToolContext, ToolMetadata, ToolResult,
    ToolRiskLevel, metadata::ToolLayer, support::text_result,
};

pub const DEFAULT_SEARCH_SESSIONS_LIMIT: usize = 8;
pub const MAX_SEARCH_SESSIONS_LIMIT: usize = 20;
pub const DEFAULT_READ_SESSION_LIMIT: usize = 30;
pub const MAX_READ_SESSION_LIMIT: usize = 80;

pub struct SearchSessionsTool;
pub struct ReadSessionTool;

fn bounded_limit(value: Option<u64>, default: usize, max: usize) -> usize {
    value
        .map(|raw| raw.max(1) as usize)
        .unwrap_or(default)
        .min(max)
}

fn text_field(params: &Value, key: &str) -> String {
    params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[async_trait]
impl Tool for SearchSessionsTool {
    fn name(&self) -> &str {
        "search_sessions"
    }

    fn description(&self) -> &str {
        "Search accessible sessions and conversations for relevant messages."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query for session titles, participants, and message text."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SEARCH_SESSIONS_LIMIT,
                    "description": "Maximum number of sessions to return. Defaults to 8."
                },
                "includeMessages": {
                    "type": "boolean",
                    "description": "Whether to include matching message snippets. Defaults to true."
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let query = text_field(&params, "query");
        if query.is_empty() {
            return Err(KordiError::Tool(
                "query cannot be empty for search_sessions".to_string(),
            ));
        }
        let limit = bounded_limit(
            params.get("limit").and_then(Value::as_u64),
            DEFAULT_SEARCH_SESSIONS_LIMIT,
            MAX_SEARCH_SESSIONS_LIMIT,
        );
        let include_messages = params.get("includeMessages").and_then(Value::as_bool);
        let Some(runtime) = ctx.session_observation.clone() else {
            return Err(KordiError::Tool(
                "session observation is unavailable in this runtime".to_string(),
            ));
        };
        let response = (runtime.search_sessions)(SearchSessionsRequest {
            query,
            limit: Some(limit),
            include_messages,
        })
        .await?;
        let text = if response.sessions.is_empty() {
            "No matching sessions found.".to_string()
        } else {
            response
                .sessions
                .iter()
                .map(|session| {
                    let mut line = format!(
                        "- `{}` — {} ({})",
                        session.session_id, session.title, session.kind
                    );
                    if !session.reason.trim().is_empty() {
                        line.push_str(&format!("; {}", session.reason));
                    }
                    for snippet in &session.snippets {
                        line.push_str(&format!(
                            "\n  - `{}` {}: {}",
                            snippet.message_id, snippet.sender, snippet.text
                        ));
                    }
                    line
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        Ok(text_result(
            text,
            Some(serde_json::to_value(response).map_err(|err| {
                KordiError::Tool(format!(
                    "Could not serialize search_sessions response: {err}"
                ))
            })?),
        ))
    }
}

#[async_trait]
impl Tool for ReadSessionTool {
    fn name(&self) -> &str {
        "read_session"
    }

    fn description(&self) -> &str {
        "Read a bounded window of messages from an accessible session."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "sessionId": {
                    "type": "string",
                    "description": "Canonical session id to read."
                },
                "aroundMessageId": {
                    "type": "string",
                    "description": "Optional message id to center the returned window around."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_READ_SESSION_LIMIT,
                    "description": "Maximum number of messages to return. Defaults to 30."
                }
            },
            "required": ["sessionId"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let session_id = text_field(&params, "sessionId");
        if session_id.is_empty() {
            return Err(KordiError::Tool(
                "sessionId cannot be empty for read_session".to_string(),
            ));
        }
        let around_message_id = params
            .get("aroundMessageId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let limit = bounded_limit(
            params.get("limit").and_then(Value::as_u64),
            DEFAULT_READ_SESSION_LIMIT,
            MAX_READ_SESSION_LIMIT,
        );
        let Some(runtime) = ctx.session_observation.clone() else {
            return Err(KordiError::Tool(
                "session observation is unavailable in this runtime".to_string(),
            ));
        };
        let response = (runtime.read_session)(ReadSessionRequest {
            session_id,
            around_message_id,
            limit: Some(limit),
        })
        .await?;
        let mut text = format!(
            "Session `{}` — {} ({})",
            response.session.session_id, response.session.title, response.session.kind
        );
        for message in &response.messages {
            text.push_str(&format!(
                "\n- `{}` {}: {}",
                message.message_id, message.sender, message.text
            ));
        }
        Ok(text_result(
            text,
            Some(serde_json::to_value(response).map_err(|err| {
                KordiError::Tool(format!("Could not serialize read_session response: {err}"))
            })?),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionObservationRuntime, Tool, ToolContext};
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    fn ctx_with_runtime(runtime: Option<SessionObservationRuntime>) -> ToolContext {
        ToolContext {
            cwd: PathBuf::from("/tmp"),
            artifacts_dir: PathBuf::from("/tmp/artifacts"),
            model: None,
            execution_policy: crate::ExecutionPolicy::Safety,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            session_observation: runtime,
            task_operator: None,
            execution_mode: crate::ToolExecutionMode::Interactive,
            request_approval: None,
        }
    }

    #[tokio::test]
    async fn search_sessions_rejects_empty_query() {
        let tool = SearchSessionsTool;
        let error = tool
            .execute(
                json!({"query":"   "}),
                &ctx_with_runtime(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect_err("empty query should fail");
        assert!(error.to_string().contains("query cannot be empty"));
    }

    #[tokio::test]
    async fn search_sessions_requires_runtime() {
        let tool = SearchSessionsTool;
        let error = tool
            .execute(
                json!({"query":"launch"}),
                &ctx_with_runtime(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect_err("missing runtime should fail");
        assert!(
            error
                .to_string()
                .contains("session observation is unavailable")
        );
    }

    #[tokio::test]
    async fn search_sessions_calls_runtime_with_capped_limit() {
        let captured = Arc::new(Mutex::new(Vec::<crate::SearchSessionsRequest>::new()));
        let captured_clone = captured.clone();
        let runtime = SessionObservationRuntime {
            search_sessions: Arc::new(move |request| {
                captured_clone.lock().expect("captured").push(request);
                Box::pin(async {
                    Ok(crate::SearchSessionsResponse {
                        sessions: vec![crate::SessionObservationSearchResult {
                            session_id: "session:launch".to_string(),
                            title: "Launch".to_string(),
                            kind: "group".to_string(),
                            participants: vec!["Alice".to_string()],
                            updated_at_label: Some("Today".to_string()),
                            reason: "Matched title".to_string(),
                            snippets: vec![crate::SessionObservationSnippet {
                                message_id: "msg:1".to_string(),
                                sender: "Alice".to_string(),
                                text: "Launch note".to_string(),
                                time_label: Some("13:04".to_string()),
                            }],
                        }],
                    })
                })
            }),
            read_session: Arc::new(|_| Box::pin(async { unreachable!("not used") })),
        };

        let result = SearchSessionsTool
            .execute(
                json!({"query":" launch ", "limit": 99}),
                &ctx_with_runtime(Some(runtime)),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("search result");
        assert!(
            result
                .content
                .iter()
                .any(|block| format!("{block:?}").contains("Launch"))
        );
        assert_eq!(captured.lock().expect("captured")[0].query, "launch");
        assert_eq!(
            captured.lock().expect("captured")[0].limit,
            Some(MAX_SEARCH_SESSIONS_LIMIT)
        );
    }

    #[tokio::test]
    async fn read_session_requires_session_id() {
        let error = ReadSessionTool
            .execute(
                json!({"sessionId":"   "}),
                &ctx_with_runtime(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect_err("blank session id should fail");
        assert!(error.to_string().contains("sessionId cannot be empty"));
    }
}
