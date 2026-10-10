use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory_guard::{MEMORY_MAX_CHARS, normalize_memory_text};
use crate::support::text_result_with;
use crate::{ReflectionLessonRequest, Tool, ToolContext, ToolMetadata, ToolResult};

pub struct ReflectionTool;

#[async_trait]
impl Tool for ReflectionTool {
    fn name(&self) -> &str {
        "reflection"
    }

    fn description(&self) -> &str {
        "Reflection tool for saving concise scoped memories from user corrections, repeated failures, or outcomes. Use conversation, group, or project scope only; never global memory. Memories sync with the account and must not record health, finances, relationships, identity attributes, credentials, or other people's private details. Side effect: stores the memory and updates the scoped memory artifact. Memories are max 500 characters."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": { "type": "string", "enum": ["conversation", "group", "project"] },
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

        let response = (runtime.save_lesson)(request).await?;
        let artifact_path = response.artifact_path.clone();
        Ok(text_result_with(
            format!("Reflection lesson saved to {artifact_path}"),
            Some(json!({
                "status": "saved",
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
    if !matches!(request.scope.as_str(), "conversation" | "group" | "project") {
        return Err(KordiError::Tool("reflection scope is invalid".to_string()));
    }
    if request.scope_id.trim().is_empty() {
        return Err(KordiError::Tool(
            "reflection scopeId cannot be empty".to_string(),
        ));
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
        assert!(tool.description().len() < 520);
        let metadata = tool.metadata();
        assert_eq!(metadata.layer, ToolLayer::Reflection);
        assert_eq!(metadata.risk, ToolRiskLevel::Low);
        assert!(!metadata.supports_parallel);
    }
}
