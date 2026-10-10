use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory_guard::{MEMORY_MAX_CHARS, normalize_memory_text};
use crate::support::text_result_with;
use crate::{ReflectionLessonRequest, Tool, ToolContext, ToolMetadata, ToolResult};

pub struct ReflectionTool;

/// Scope id of every `global` memory: they belong to the whole account.
pub const GLOBAL_SCOPE_ID: &str = "account";

#[async_trait]
impl Tool for ReflectionTool {
    fn name(&self) -> &str {
        "reflection"
    }

    fn description(&self) -> &str {
        "Saves a concise memory after user corrections, repeated failures, or outcomes. Scopes: conversation, group, project, or global (scopeId `account`) only for preferences the user wants everywhere (\"from now on\", \"always\"). First read the scope's memories; never save one that repeats or restates them. When a preference changes, save the corrected version. Memories sync with the account and must not record health, finances, relationships, identity attributes, credentials, or other people's private details. Side effect: stores the memory and updates the scoped memory artifact. Max 500 characters."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": { "type": "string", "enum": ["global", "conversation", "group", "project"] },
                "scopeId": { "type": "string" },
                "source": { "type": "string", "enum": ["user_correction", "repeated_failure", "outcome", "manual"] },
                "lesson": { "type": "string", "description": "Concise memory to save to the scoped memory artifact, max 500 characters." }
            },
            "required": ["scope", "scopeId", "source", "lesson"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::reflection()
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let request: ReflectionLessonRequest = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid reflection parameters: {err}")))?;
        validate_request(&request)?;

        let Some(runtime) = ctx.reflection.clone() else {
            return Err(KordiError::Tool(
                "reflection is unavailable because scoped lesson storage is not configured"
                    .to_string(),
            ));
        };

        let lesson = normalize_memory_text(&request.lesson);
        let response = (runtime.save_lesson)(request).await?;
        let artifact_path = response.artifact_path.clone();
        let (text, status) = if response.already_saved {
            (format!("Memory already saved: {lesson}"), "already_saved")
        } else {
            (
                format!("Reflection lesson saved to {artifact_path}"),
                "saved",
            )
        };
        Ok(text_result_with(
            text,
            Some(json!({
                "status": status,
                "lessonId": response.lesson_id,
                "scope": response.scope,
                "scopeId": response.scope_id,
                "artifactPath": artifact_path,
            })),
            false,
            Some(std::path::PathBuf::from(response.artifact_path)),
        ))
    }
}

fn validate_request(request: &ReflectionLessonRequest) -> KordiResult<()> {
    if !matches!(
        request.scope.as_str(),
        "global" | "conversation" | "group" | "project"
    ) {
        return Err(KordiError::Tool("reflection scope is invalid".to_string()));
    }
    if request.scope_id.trim().is_empty() {
        return Err(KordiError::Tool(
            "reflection scopeId cannot be empty".to_string(),
        ));
    }
    if request.scope == "global" && request.scope_id.trim() != GLOBAL_SCOPE_ID {
        return Err(KordiError::Tool(format!(
            "reflection scopeId must be `{GLOBAL_SCOPE_ID}` for global memories"
        )));
    }
    if !matches!(
        request.source.as_str(),
        "user_correction" | "repeated_failure" | "outcome" | "manual"
    ) {
        return Err(KordiError::Tool("reflection source is invalid".to_string()));
    }
    // Length and emptiness only. The sensitive keyword and quote guards run
    // in the runtime, which knows the memory settings.
    let lesson = normalize_memory_text(&request.lesson);
    if lesson.is_empty() {
        return Err(KordiError::Tool(
            "reflection memory cannot be empty".to_string(),
        ));
    }
    if lesson.chars().count() > MEMORY_MAX_CHARS {
        return Err(KordiError::Tool(format!(
            "reflection memory must be {MEMORY_MAX_CHARS} characters or fewer"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{Tool, ToolLayer, ToolRiskLevel};

    #[test]
    fn reflection_tool_has_short_description_and_reflection_metadata() {
        let tool = super::ReflectionTool;
        assert_eq!(tool.name(), "reflection");
        assert!(tool.description().contains("Side effect"));
        assert!(tool.description().contains("must not record health"));
        assert!(tool.description().contains("global (scopeId `account`)"));
        assert!(tool.description().contains("never save one that repeats"));
        assert!(tool.description().len() < 700);
        let metadata = tool.metadata();
        assert_eq!(metadata.layer, ToolLayer::Reflection);
        assert_eq!(metadata.risk, ToolRiskLevel::Low);
        assert!(!metadata.supports_parallel);
    }

    fn context(already_saved: bool) -> crate::ToolContext {
        let save_lesson: crate::SaveReflectionLessonFn =
            std::sync::Arc::new(move |request: crate::ReflectionLessonRequest| {
                Box::pin(async move {
                    Ok(crate::ReflectionLessonResponse {
                        lesson_id: "mem_1".to_string(),
                        artifact_path: format!("memory/{}/{}", request.scope, request.scope_id),
                        scope: request.scope,
                        scope_id: request.scope_id,
                        already_saved,
                    })
                })
            });
        crate::ToolContext {
            cwd: "/tmp".into(),
            artifacts_dir: "/tmp".into(),
            model: None,
            execution_policy: crate::ExecutionPolicy::Safety,
            invocation_id: None,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: Some(crate::ReflectionRuntime { save_lesson }),
            session_observation: None,
            task_operator: None,
            schedule_task: None,
            mac_local: None,
            execution_mode: crate::ToolExecutionMode::Interactive,
            connector_tools: None,
            request_approval: None,
        }
    }

    async fn run(params: serde_json::Value, already_saved: bool) -> Result<String, String> {
        super::ReflectionTool
            .execute(
                params,
                &context(already_saved),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .map(|result| match &result.content[0] {
                kordi_core::types::ContentBlock::Text { text } => text.clone(),
                other => panic!("unexpected content {other:?}"),
            })
            .map_err(|error| error.to_string())
    }

    fn params(scope: &str, scope_id: &str) -> serde_json::Value {
        serde_json::json!({
            "scope": scope,
            "scopeId": scope_id,
            "source": "user_correction",
            "lesson": "  Always answer   in British English. ",
        })
    }

    #[tokio::test]
    async fn global_scope_requires_the_account_scope_id() {
        assert_eq!(
            run(params("global", "account"), false).await.unwrap(),
            "Reflection lesson saved to memory/global/account"
        );
        let error = run(params("global", "session-1"), false).await.unwrap_err();
        assert!(error.contains("must be `account`"), "{error}");
        assert!(run(params("workspace", "account"), false).await.is_err());
    }

    #[tokio::test]
    async fn existing_memory_is_reported_as_already_saved() {
        assert_eq!(
            run(params("conversation", "session-1"), true)
                .await
                .unwrap(),
            "Memory already saved: Always answer in British English."
        );
    }
}
