use super::*;
use reqwest::{Client, Url};
use std::time::Duration;

/// Direct HTTP keeps the runner native. Credentials and response bodies never enter errors.
pub struct JevProvider {
    client: Client,
    endpoint: Url,
    api_key: String,
    pub model: String,
    gateway: bool,
}

impl JevProvider {
    pub fn from_env() -> Result<Self, EvaluationError> {
        match std::env::var("KORDI_JEV_PROVIDER")
            .as_deref()
            .unwrap_or("typesafe")
        {
            "typesafe" => Self::new(
                std::env::var("KORDI_JEV_API_KEY").map_err(|_| EvaluationError::Unavailable)?,
                std::env::var("KORDI_JEV_MODEL").unwrap_or_else(|_| "jev-1.13".into()),
            ),
            "vercel" => Self::vercel(
                std::env::var("AI_GATEWAY_API_KEY").map_err(|_| EvaluationError::Unavailable)?,
                std::env::var("KORDI_JEV_MODEL").unwrap_or_else(|_| "typesafe-ai/jev".into()),
            ),
            _ => Err(EvaluationError::Unavailable),
        }
    }

    /// Mirrors the experimental v4 transport in Vercel's gateway-evaluation-model.ts.
    pub fn vercel(api_key: String, model: String) -> Result<Self, EvaluationError> {
        let mut provider = Self::with_endpoint(
            api_key,
            model,
            "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
        )?;
        provider.gateway = true;
        Ok(provider)
    }

    pub fn new(api_key: String, model: String) -> Result<Self, EvaluationError> {
        Self::with_endpoint(api_key, model, "https://api.typesafe.ai/v1/systemone")
    }

    fn with_endpoint(
        api_key: String,
        model: String,
        endpoint: &str,
    ) -> Result<Self, EvaluationError> {
        if api_key.trim().is_empty() || model.trim().is_empty() {
            return Err(EvaluationError::Unavailable);
        }
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_millis(500))
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|_| EvaluationError::Unavailable)?,
            endpoint: Url::parse(endpoint).map_err(|_| EvaluationError::Unavailable)?,
            api_key,
            model,
            gateway: false,
        })
    }
}

#[async_trait]
impl EvaluationProvider for JevProvider {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationResponse, EvaluationError> {
        request.validate()?;
        let body = if self.gateway {
            let mut questions =
                serde_json::to_value(&request.questions).map_err(|_| EvaluationError::Invalid)?;
            for question in questions
                .as_object_mut()
                .ok_or(EvaluationError::Invalid)?
                .values_mut()
            {
                if question["type"] == "noul" {
                    question["type"] = Value::String("boolean".into());
                }
            }
            serde_json::json!({"state": request.state, "questions": questions})
        } else {
            serde_json::json!({"model": self.model, "state": request.state, "questions": request.questions})
        };
        for attempt in 0..2 {
            let mut call = self
                .client
                .post(self.endpoint.clone())
                .bearer_auth(&self.api_key)
                .json(&body);
            if self.gateway {
                call = call
                    .header("ai-model-id", &self.model)
                    .header("ai-evaluation-model-specification-version", "4")
                    .header("ai-gateway-protocol-version", "0.0.1")
                    .header("ai-gateway-auth-method", "api-key");
            }
            let mut response = call
                .send()
                .await
                .map_err(|_| EvaluationError::Unavailable)?;
            let status = response.status();
            if attempt == 0 && (status.as_u16() == 429 || status.is_server_error()) {
                let delay = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(Duration::from_millis(100));
                // Longer backoffs belong to a subsequent job, not this routing decision.
                if delay > Duration::from_millis(250) {
                    return Err(EvaluationError::Unavailable);
                }
                tokio::time::sleep(delay).await;
                continue;
            }
            if !status.is_success() {
                return Err(EvaluationError::Http(status.as_u16()));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| EvaluationError::Unavailable)?
            {
                if bytes.len() + chunk.len() > 64_000 {
                    return Err(EvaluationError::Invalid);
                }
                bytes.extend_from_slice(&chunk);
            }
            let result: EvaluationResponse = if self.gateway {
                gateway_response(&bytes, request, &self.model)?
            } else {
                let result: EvaluationResponse =
                    serde_json::from_slice(&bytes).map_err(|_| EvaluationError::Invalid)?;
                if result.answers.values().any(|answer| {
                    matches!(
                        answer,
                        Answer::Choice {
                            confidence: None,
                            ..
                        } | Answer::Score {
                            confidence: None,
                            ..
                        }
                    )
                }) {
                    return Err(EvaluationError::Invalid);
                }
                result
            };
            result.validate(request)?;
            return Ok(result);
        }
        Err(EvaluationError::Unavailable)
    }
}

#[cfg(test)]
mod tests;

// Gateway exposes probability distributions but no TypeSafe confidence or score legend.
// Preserve that absence and use the caller's declared score rubric; never fabricate confidence.
fn gateway_response(
    bytes: &[u8],
    request: &EvaluationRequest,
    model: &str,
) -> Result<EvaluationResponse, EvaluationError> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| EvaluationError::Invalid)?;
    if value
        .get("warnings")
        .is_some_and(|w| !w.as_array().is_some_and(Vec::is_empty))
    {
        return Err(EvaluationError::Invalid);
    }
    let answers = value["answers"]
        .as_object_mut()
        .ok_or(EvaluationError::Invalid)?;
    for (key, answer) in answers {
        let fields = answer.as_object_mut().ok_or(EvaluationError::Invalid)?;
        match request.questions.get(key).ok_or(EvaluationError::Invalid)? {
            Question::Noul { .. } => {
                if fields.get("type").and_then(Value::as_str) != Some("boolean") {
                    return Err(EvaluationError::Invalid);
                }
                let p = fields
                    .remove("probability")
                    .ok_or(EvaluationError::Invalid)?;
                fields.insert("type".into(), Value::String("noul".into()));
                fields.insert("noul".into(), p);
            }
            Question::Choice { .. } => {
                fields.remove("confidence");
            }
            Question::Score { criteria, .. } => {
                fields.remove("confidence");
                fields.insert(
                    "legend".into(),
                    serde_json::json!(criteria
                        .iter()
                        .enumerate()
                        .map(|(i, text)| (i.to_string(), text))
                        .collect::<BTreeMap<_, _>>()),
                );
            }
        }
    }
    value["model"] = Value::String(model.into());
    value["usage"] = serde_json::json!({
        "input_tokens":value["usage"]["inputTokens"].as_u64().unwrap_or(0),
        "output_tokens":value["usage"]["outputTokens"].as_u64().unwrap_or(0),
    });
    serde_json::from_value(value).map_err(|_| EvaluationError::Invalid)
}
