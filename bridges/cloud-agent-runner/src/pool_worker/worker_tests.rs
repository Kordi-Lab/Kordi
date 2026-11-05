use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::run::RunOutcome;
use super::test_server::{config, temp_file, MockServer, Recorded};
use super::{LeaseOutcome, PoolWorker};
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall, OpenAiProviderConfig,
};

const LEASE_TOKEN: &str = "synthetic-lease";

/// Replies from a fixed script, or hangs when the script is empty.
#[derive(Default)]
struct ScriptedProvider {
    replies: Mutex<VecDeque<Result<ModelProviderResponse, String>>>,
    calls: Mutex<Vec<(String, String, usize, usize)>>,
}

impl ScriptedProvider {
    fn new(replies: Vec<Result<ModelProviderResponse, String>>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            calls: Mutex::default(),
        }
    }
}

#[async_trait]
impl CloudModelProvider for ScriptedProvider {
    async fn next_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        self.calls.lock().unwrap().push((
            auth.model.clone(),
            auth.api_key.clone(),
            messages.len(),
            tools.len(),
        ));
        let next = self.replies.lock().unwrap().pop_front();
        match next {
            Some(reply) => reply.map_err(ModelLoopError::Provider),
            None => std::future::pending().await,
        }
    }
}

struct Harness {
    server: MockServer,
    worker: PoolWorker<ScriptedProvider>,
    _files: Vec<std::path::PathBuf>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        for file in &self._files {
            let _ = std::fs::remove_file(file);
        }
    }
}

fn lease_body(feature: &str, prompt: &str) -> String {
    json!({"run": {
        "runId": if feature == "grounding" { "cg_synthetic" } else { "pip_synthetic" },
        "feature": feature,
        "leaseToken": LEASE_TOKEN,
        "systemPrompt": "Synthetic instructions.",
        "prompt": prompt,
        "thinking": null,
        "leaseSeconds": 120
    }})
    .to_string()
}

async fn harness(
    handler: impl Fn(&Recorded) -> (u16, String) + Send + Sync + 'static,
    provider: ScriptedProvider,
) -> Harness {
    let server = MockServer::start(handler).await;
    let identity = temp_file("synthetic-identity\n");
    let key = temp_file("synthetic-model-key");
    let identity_path = identity.to_str().unwrap().to_string();
    let key_path = key.to_str().unwrap().to_string();
    let settings = [
        ("POOL_ID", "partner"),
        ("CONTROL_PLANE_URL", server.url.as_str()),
        ("AUDIENCE", "https://control.example.test"),
        ("PROVIDER", "openrouter"),
        ("MODEL", "vendor/synthetic-model"),
        ("BASE_URL", "https://models.example.test/api/v1"),
        ("API_KEY_FILE", key_path.as_str()),
        ("IDENTITY_TOKEN_FILE", identity_path.as_str()),
        ("ID", "worker-a"),
    ];
    let config = config(&settings, "http://127.0.0.1:9");
    let worker = PoolWorker::new(&config, provider).unwrap();
    Harness {
        server,
        worker,
        _files: vec![identity, key],
    }
}

fn ok() -> (u16, String) {
    (200, "{\"ok\":true}".into())
}

fn find<'a>(requests: &'a [Recorded], suffix: &str) -> &'a Recorded {
    requests
        .iter()
        .find(|r| r.path.ends_with(suffix))
        .unwrap_or_else(|| panic!("no request to {suffix}"))
}

#[tokio::test]
async fn empty_lease_is_idle_and_carries_identity() {
    let h = harness(
        |_| (200, "{\"run\":null}".into()),
        ScriptedProvider::default(),
    )
    .await;
    assert!(matches!(h.worker.lease().await, LeaseOutcome::Idle));
    let requests = h.server.recorded();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/v1/cloud/pool-workers/lease");
    assert_eq!(
        requests[0].header("authorization").as_deref(),
        Some("bearer synthetic-identity")
    );
    assert_eq!(
        requests[0].body,
        json!({"poolId": "partner", "workerId": "worker-a"})
    );
}

#[tokio::test]
async fn stopped_missing_or_refused_pool_backs_off() {
    for (status, code) in [
        (503, "pool_stopped"),
        (404, "pool_not_found"),
        (401, "pool_worker_unauthorized"),
    ] {
        let body = json!({"errorCode": code, "message": "synthetic"}).to_string();
        let h = harness(move |_| (status, body.clone()), ScriptedProvider::default()).await;
        assert!(matches!(h.worker.lease().await, LeaseOutcome::Backoff));
    }
    let h = harness(|_| (500, "oops".into()), ScriptedProvider::default()).await;
    assert!(matches!(h.worker.lease().await, LeaseOutcome::Idle));
}

#[tokio::test]
async fn system_agent_run_forwards_plan_card_and_completes_with_envelope() {
    let prompt = json!({"messages": [{"text": "Dinner on Friday?"}]}).to_string();
    let lease = lease_body("system_agent", &prompt);
    let provider = ScriptedProvider::new(vec![
        Ok(ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call-1".into(),
            name: "plan_card".into(),
            arguments: json!({"action": "rsvp", "response": "yes"}),
        }])),
        Ok(ModelProviderResponse::FinalText(
            "{\"message\":\"Card updated.\"}".into(),
        )),
    ]);
    let h = harness(
        move |request| match request.path.rsplit('/').next().unwrap() {
            "lease" => (200, lease.clone()),
            "plan-card" => (200, "{\"success\":true,\"revision\":2}".into()),
            _ => ok(),
        },
        provider,
    )
    .await;
    let LeaseOutcome::Run(lease) = h.worker.lease().await else {
        panic!("expected a run");
    };
    assert_eq!(h.worker.process(lease).await, RunOutcome::Completed);

    let requests = h.server.recorded();
    let plan = find(&requests, "/runs/pip_synthetic/plan-card");
    assert_eq!(
        plan.body,
        json!({
            "poolId": "partner",
            "workerId": "worker-a",
            "leaseToken": LEASE_TOKEN,
            "request": {"action": "rsvp", "response": "yes"}
        })
    );
    assert_eq!(
        plan.header("authorization").as_deref(),
        Some("bearer synthetic-identity")
    );
    let complete = find(&requests, "/runs/pip_synthetic/complete");
    assert_eq!(complete.body["leaseToken"], LEASE_TOKEN);
    assert_eq!(complete.body["poolId"], "partner");
    assert_eq!(
        complete.body["responseText"],
        crate::system_agent::normalize_output("{\"message\":\"Card updated.\"}")
    );
    assert!(requests.iter().all(|r| !r.path.ends_with("/fail")));
    let calls = h.worker.provider.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, "vendor/synthetic-model");
    assert_eq!(calls[0].1, "synthetic-model-key");
    assert_eq!(calls[0].3, 1, "only plan_card is offered");
    // The second turn sees the plan card result.
    assert_eq!(calls[1].2, 4);
}

#[tokio::test]
async fn grounding_run_is_one_completion_without_tools() {
    let lease = lease_body("grounding", "Synthetic grounding prompt.");
    let provider = ScriptedProvider::new(vec![Ok(ModelProviderResponse::FinalText(
        "{\"cards\":[]}".into(),
    ))]);
    let h = harness(
        move |request| {
            if request.path.ends_with("/lease") {
                (200, lease.clone())
            } else {
                ok()
            }
        },
        provider,
    )
    .await;
    let LeaseOutcome::Run(lease) = h.worker.lease().await else {
        panic!("expected a run");
    };
    assert_eq!(h.worker.process(lease).await, RunOutcome::Completed);
    let requests = h.server.recorded();
    let complete = find(&requests, "/runs/cg_synthetic/complete");
    assert_eq!(
        complete.body,
        json!({
            "poolId": "partner",
            "workerId": "worker-a",
            "leaseToken": LEASE_TOKEN,
            "responseText": "{\"cards\":[]}"
        })
    );
    let calls = h.worker.provider.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!((calls[0].2, calls[0].3), (2, 0));
}

#[tokio::test]
async fn provider_failure_posts_fail_with_the_pool_error_code() {
    let lease = lease_body("grounding", "Synthetic grounding prompt.");
    let provider = ScriptedProvider::new(vec![Err("upstream quoted content".into())]);
    let h = harness(
        move |request| {
            if request.path.ends_with("/lease") {
                (200, lease.clone())
            } else {
                ok()
            }
        },
        provider,
    )
    .await;
    let LeaseOutcome::Run(lease) = h.worker.lease().await else {
        panic!("expected a run");
    };
    assert_eq!(h.worker.process(lease).await, RunOutcome::Failed);
    let requests = h.server.recorded();
    let fail = find(&requests, "/runs/cg_synthetic/fail");
    assert_eq!(
        fail.body,
        json!({
            "poolId": "partner",
            "workerId": "worker-a",
            "leaseToken": LEASE_TOKEN,
            "errorCode": "pool_worker_run_failed"
        })
    );
    assert!(super::client::is_error_code("pool_worker_run_failed"));
    assert!(requests.iter().all(|r| !r.path.ends_with("/complete")));
}

#[tokio::test]
async fn grounding_tool_calls_and_unknown_features_fail() {
    for (feature, reply) in [
        (
            "grounding",
            Some(ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "call-1".into(),
                name: "anything".into(),
                arguments: json!({}),
            }])),
        ),
        (
            "grounding",
            Some(ModelProviderResponse::FinalText("  ".into())),
        ),
        ("mystery", None),
    ] {
        let lease = lease_body(feature, "prompt");
        let provider = ScriptedProvider::new(reply.into_iter().map(Ok).collect());
        let h = harness(
            move |r| {
                if r.path.ends_with("/lease") {
                    (200, lease.clone())
                } else {
                    ok()
                }
            },
            provider,
        )
        .await;
        let LeaseOutcome::Run(lease) = h.worker.lease().await else {
            panic!("expected a run");
        };
        assert_eq!(h.worker.process(lease).await, RunOutcome::Failed);
        assert!(h.server.paths().iter().any(|p| p.ends_with("/fail")));
    }
}

#[tokio::test]
async fn heartbeat_cancel_or_lost_lease_abandons_the_run() {
    for heartbeat in [
        (200, "{\"cancelRequested\":true}".to_string()),
        (404, "{\"errorCode\":\"run_not_found\"}".to_string()),
        (503, "{\"errorCode\":\"pool_stopped\"}".to_string()),
    ] {
        let lease = lease_body("grounding", "prompt");
        let beats = Arc::new(Mutex::new(0));
        let counter = Arc::clone(&beats);
        let mut h = harness(
            move |r| {
                if r.path.ends_with("/lease") {
                    (200, lease.clone())
                } else if r.path.ends_with("/heartbeat") {
                    let mut count = counter.lock().unwrap();
                    *count += 1;
                    // The first renewal succeeds; the second ends the run.
                    if *count == 1 {
                        (200, "{\"cancelRequested\":false}".into())
                    } else {
                        heartbeat.clone()
                    }
                } else {
                    ok()
                }
            },
            // An empty script hangs, like a slow provider.
            ScriptedProvider::default(),
        )
        .await;
        h.worker.heartbeat_interval = Duration::from_millis(20);
        let LeaseOutcome::Run(lease) = h.worker.lease().await else {
            panic!("expected a run");
        };
        assert_eq!(h.worker.process(lease).await, RunOutcome::Abandoned);
        let paths = h.server.paths();
        assert!(paths
            .iter()
            .all(|p| !p.ends_with("/complete") && !p.ends_with("/fail")));
        let recorded = h.server.recorded();
        assert_eq!(
            find(&recorded, "/heartbeat").body["leaseToken"],
            LEASE_TOKEN
        );
        assert_eq!(*beats.lock().unwrap(), 2);
    }
}

#[tokio::test]
async fn a_refused_result_fails_the_run_but_a_lost_lease_does_not() {
    for (status, fails) in [(400, true), (404, false), (409, false), (503, false)] {
        let lease = lease_body("grounding", "Synthetic grounding prompt.");
        let provider = ScriptedProvider::new(vec![Ok(ModelProviderResponse::FinalText(
            "{\"cards\":[]}".into(),
        ))]);
        let h = harness(
            move |request| {
                if request.path.ends_with("/lease") {
                    (200, lease.clone())
                } else if request.path.ends_with("/complete") {
                    (
                        status,
                        json!({"errorCode": "refused", "message": "Refused."}).to_string(),
                    )
                } else {
                    ok()
                }
            },
            provider,
        )
        .await;
        let LeaseOutcome::Run(lease) = h.worker.lease().await else {
            panic!("expected a run");
        };
        assert_eq!(h.worker.process(lease).await, RunOutcome::Failed);
        let requests = h.server.recorded();
        let failed = requests
            .iter()
            .any(|request| request.path.ends_with("/runs/cg_synthetic/fail"));
        assert_eq!(failed, fails, "status {status}");
    }
}
