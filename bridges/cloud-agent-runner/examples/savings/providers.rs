use async_trait::async_trait;
use kordi_cloud_agent_runner::{client::*, evaluation::*, model_loop::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationMetrics {
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub tool_requests: u64,
    pub responses: Vec<Value>,
}
pub struct Llm {
    pub remote: Option<Arc<super::remote::Remote>>,
    pub client: reqwest::Client,
    pub key: String,
    pub model: String,
    pub endpoint: &'static str,
    pub metrics: Mutex<GenerationMetrics>,
    pub total_calls: Arc<AtomicUsize>,
}
#[async_trait]
impl CloudModelProvider for Llm {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        if self.total_calls.fetch_add(1, Ordering::SeqCst) >= 64 {
            return Err(ModelLoopError::Provider(
                "Benchmark request budget exhausted".into(),
            ));
        }
        self.metrics.lock().unwrap().calls += 1;
        let request = json!({"model":self.model,"messages":messages,"tools":tools,"stream":false,"temperature":0,"reasoning_effort":"none","max_completion_tokens":2048});
        let body: Value = if let Some(remote) = &self.remote {
            let reply = remote
                .complete(&request)
                .await
                .map_err(|error| ModelLoopError::Provider(error.into()))?;
            if reply["status"] != 200 {
                return Err(ModelLoopError::Provider(format!(
                    "Benchmark generation HTTP {}",
                    reply["status"]
                )));
            }
            reply["body"].clone()
        } else {
            let response = self
                .client
                .post(self.endpoint)
                .bearer_auth(&self.key)
                .json(&request)
                .send()
                .await
                .map_err(|_| {
                    ModelLoopError::Provider("Benchmark generation transport failed".into())
                })?;
            if !response.status().is_success() {
                return Err(ModelLoopError::Provider(format!(
                    "Benchmark generation HTTP {}",
                    response.status().as_u16()
                )));
            }
            response.json().await.map_err(|_| {
                ModelLoopError::Provider("Benchmark generation response invalid".into())
            })?
        };
        let input = body["usage"]["prompt_tokens"]
            .as_u64()
            .ok_or_else(|| ModelLoopError::Provider("Benchmark input usage missing".into()))?;
        let output = body["usage"]["completion_tokens"]
            .as_u64()
            .ok_or_else(|| ModelLoopError::Provider("Benchmark output usage missing".into()))?;
        let cached = body["usage"]["prompt_tokens_details"]["cached_tokens"]
            .as_u64()
            .unwrap_or(0);
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.input_tokens += input;
            metrics.output_tokens += output;
            metrics.cached_input_tokens += cached;
            // Only synthetic generated messages and usage are retained, never headers or request IDs.
            metrics.responses.push(json!({"message":body["choices"][0]["message"],"finishReason":body["choices"][0]["finish_reason"],"usage":body["usage"]}));
        }
        if body["choices"][0]["finish_reason"] == "length" {
            return Err(ModelLoopError::Provider(
                "Benchmark output token limit reached".into(),
            ));
        }
        let message = &body["choices"][0]["message"];
        if let Some(calls) = message["tool_calls"].as_array().filter(|c| !c.is_empty()) {
            let mut parsed = Vec::new();
            for call in calls {
                let arguments =
                    serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or(""))
                        .map_err(|_| {
                            ModelLoopError::Provider("Benchmark tool arguments invalid".into())
                        })?;
                parsed.push(ModelToolCall {
                    id: call["id"].as_str().unwrap_or("").into(),
                    name: call["function"]["name"].as_str().unwrap_or("").into(),
                    arguments,
                });
            }
            self.metrics.lock().unwrap().tool_requests += parsed.len() as u64;
            return Ok(ModelProviderResponse::ToolCalls(parsed));
        }
        Ok(ModelProviderResponse::FinalText(
            message["content"].as_str().unwrap_or("").into(),
        ))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationRecord {
    pub elapsed_ms: u64,
    pub response: Option<EvaluationResponse>,
    pub error: Option<String>,
}
pub struct Evaluator {
    pub inner: JevProvider,
    pub records: Mutex<Vec<EvaluationRecord>>,
}
#[async_trait]
impl EvaluationProvider for Evaluator {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationResponse, EvaluationError> {
        let start = std::time::Instant::now();
        let index = {
            let mut records = self.records.lock().unwrap();
            let index = records.len();
            records.push(EvaluationRecord {
                elapsed_ms: 0,
                response: None,
                error: Some("Evaluation was cancelled before a response; usage unknown".into()),
            });
            index
        };
        let result = self.inner.evaluate(request).await;
        self.records.lock().unwrap()[index] = EvaluationRecord {
            elapsed_ms: start.elapsed().as_millis() as u64,
            response: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(ToString::to_string),
        };
        result
    }
}

pub struct SimulatedClient {
    pub card: Mutex<Value>,
    pub actions: Mutex<Vec<Value>>,
}
#[async_trait]
impl CloudAgentRunClient for SimulatedClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn complete_run(&self, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fetch_provider_auth(
        &self,
        _: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        Ok(material())
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Artifacts unavailable in synthetic benchmark".into(),
        ))
    }
    async fn plan_card_action(&self, _: &str, args: Value) -> Result<Value, RunnerClientError> {
        let action = args["action"].as_str().unwrap_or("");
        let mut card = self.card.lock().unwrap();
        if action == "propose" {
            if args["conversationId"] != "synthetic-group" {
                return Ok(json!({"error":"Wrong synthetic conversation"}));
            }
            *card = json!({"eventId":"synthetic-event","revision":1,"state":args["state"],"title":args["title"],"startAt":args["startAt"],"endAt":args["endAt"],"location":args["location"],"participants":args["participants"],"options":args.get("options").cloned().unwrap_or(json!([])),"counts":{"participants":2,"going":0,"declined":0,"pending":2,"voted":0},"participantsTruncated":false});
        } else {
            if card.is_null() || args["eventId"] != card["eventId"] {
                return Ok(json!({"error":"Unknown synthetic event"}));
            }
            if ["confirm", "cancel", "reopen"].contains(&action)
                && args["revision"] != card["revision"]
            {
                return Ok(json!({"error":"Stale synthetic revision"}));
            }
            if action == "rsvp" {
                if let Some(people) = card["participants"].as_array_mut() {
                    for person in people {
                        if person["participantId"] == args["participantId"] {
                            person["rsvp"] = args["rsvp"].clone();
                        }
                    }
                }
            }
            if action == "vote" {
                card["counts"]["voted"] = json!(1);
            }
            if let Some(state) = match action {
                "confirm" => Some("confirmed"),
                "cancel" => Some("canceled"),
                "reopen" => Some("awaitingConfirmation"),
                _ => None,
            } {
                card["state"] = json!(state);
            }
            let revision = card["revision"].as_u64().unwrap_or(0) + 1;
            card["revision"] = json!(revision);
        }
        let participants = card["participants"].as_array().cloned().unwrap_or_default();
        let going = participants.iter().filter(|p| p["rsvp"] == "yes").count();
        let declined = participants.iter().filter(|p| p["rsvp"] == "no").count();
        card["counts"]["participants"] = json!(participants.len());
        card["counts"]["going"] = json!(going);
        card["counts"]["declined"] = json!(declined);
        card["counts"]["pending"] = json!(participants.len() - going - declined);
        self.actions.lock().unwrap().push(args);
        Ok(card.clone())
    }
}
pub fn material() -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "synthetic".into(),
        provider: "openai".into(),
        auth_choice: "synthetic".into(),
        payload: json!({"apiKey":"synthetic-placeholder","model":"gpt-5.6-luna"}),
    }
}
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap()
}

#[derive(Deserialize)]
pub struct Fixture {
    pub id: String,
    pub consumer: String,
    pub material: bool,
    pub expected: String,
    pub input: Value,
    pub arms: Vec<String>,
}
