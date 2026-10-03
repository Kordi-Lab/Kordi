//! Request bodies a runner sends to complete or fail a run.

use serde::Deserialize;

/// The longest model name a runner may report for a run.
pub const DISCLOSED_MODEL_LIMIT: usize = 200;

#[derive(Debug, Deserialize)]
pub struct CompleteRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "responseText")]
    pub response_text: String,
    #[serde(rename = "ompState", default)]
    pub omp_state: Option<crate::cloud_agent_runtime::runs::omp_state::OmpState>,
    /// The model the runner actually called, shown in "About this reply".
    /// Older runners omit it.
    #[serde(default)]
    pub model: Option<String>,
}

impl CompleteRunRequest {
    /// The reported model when it is a plausible name: non-empty and at most
    /// 200 characters. Anything else is not recorded, and the reply shows the
    /// model as not reported; the reply itself still completes.
    pub fn disclosed_model(&self) -> Option<String> {
        self.model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .filter(|model| model.chars().count() <= DISCLOSED_MODEL_LIMIT)
            .map(str::to_string)
    }

    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct FailRunRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "errorCode")]
    pub error_code: String,
    pub message: String,
}

impl FailRunRequest {
    pub fn runner_id(&self) -> Option<String> {
        let trimmed = self.runner_id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub fn error_code(&self) -> String {
        let trimmed = self.error_code.trim();
        if trimmed.is_empty() {
            "runner_error".to_string()
        } else {
            trimmed.to_string()
        }
    }
}
