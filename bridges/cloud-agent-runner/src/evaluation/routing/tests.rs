use super::*;
use crate::evaluation::{Answer, Question, Usage};
use async_trait::async_trait;
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Fake {
    route: &'static str,
    confidence: f64,
    calls: AtomicUsize,
    fails: bool,
    delay: Duration,
}
impl Fake {
    fn new(route: &'static str) -> Arc<Self> {
        Arc::new(Self {
            route,
            confidence: 0.99,
            calls: AtomicUsize::new(0),
            fails: false,
            delay: Duration::ZERO,
        })
    }
}
#[async_trait]
impl EvaluationProvider for Fake {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationResponse, EvaluationError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(self.delay).await;
        if self.fails {
            return Err(EvaluationError::Unavailable);
        }
        let answers = request
            .questions
            .iter()
            .map(|(key, question)| {
                let Question::Choice { criteria, .. } = question else {
                    panic!("choice expected")
                };
                let selected = match key.as_str() {
                    "route" => self.route,
                    "action" => "rsvp",
                    "session" => "s0",
                    _ => panic!("unexpected question"),
                };
                let probabilities = criteria
                    .keys()
                    .map(|option| {
                        (
                            option.clone(),
                            if option == selected {
                                self.confidence
                            } else {
                                (1.0 - self.confidence) / (criteria.len() - 1) as f64
                            },
                        )
                    })
                    .collect();
                (
                    key.clone(),
                    Answer::Choice {
                        choice: selected.into(),
                        probabilities,
                        confidence: Some(self.confidence),
                    },
                )
            })
            .collect();
        Ok(EvaluationResponse {
            model: "test".into(),
            answers,
            usage: Usage {
                input_tokens: 100,
                output_tokens: 0,
            },
        })
    }
}
fn run() -> CloudAgentRun {
    serde_json::from_value(json!({"runId":"digest_test","status":"running","sessionId":"digest:viewer","ownerAccountId":"viewer","requesterAccountId":"viewer","providerAuthAvailable":true,"prompt":"{}"})).unwrap()
}
fn digest() -> Value {
    json!({"sources":[{"id":"m1","sessionId":"s1","sessionTitle":"Planning","text":"Thanks!","version":1}],
        "partial":false,"previous":{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[]},
        "changes":{"sources":[{"id":"m1","sessionId":"s1","text":"Thanks!","version":1}],"relatedSources":[],"removedSourceIds":[],"calendarEvents":[],"removedCalendarEventIds":[],"existingTasks":[],"removedTaskIds":[],"newlyDueReminderIds":[],"preferencesChanged":false}})
}
fn pip() -> Value {
    json!({"hooks":[{"name":"new_messages"}],"messages":[{"messageId":"m1","text":"Lovely weather","isNew":true,"fromPip":false}],"openCard":null})
}
fn router(fake: Arc<Fake>, mode: Mode) -> Router {
    Router::new(Some(fake), "test".into(), mode, mode)
}

#[tokio::test]
async fn flags_shadow_and_low_confidence_preserve_generation() {
    for (mode, confidence, expected_calls) in [
        (Mode::Off, 0.99, 0),
        (Mode::Shadow, 0.99, 1),
        (Mode::Enabled, 0.7, 1),
    ] {
        let fake = Arc::new(Fake {
            confidence,
            ..Arc::try_unwrap(Fake::new("skip")).ok().unwrap()
        });
        let router = router(fake.clone(), mode);
        assert_eq!(
            router
                .route(Consumer::Digest, &run(), &digest(), &digest())
                .await,
            Route::Generate
        );
        assert_eq!(fake.calls.load(Ordering::SeqCst), expected_calls);
    }
    assert_eq!(Mode::parse("true"), Mode::Off);
    assert_eq!(Mode::parse("enabled"), Mode::Enabled);
}

#[tokio::test]
async fn independent_flags_and_skip_routes() {
    let fake = Fake::new("skip");
    let router = Router::new(Some(fake.clone()), "test".into(), Mode::Off, Mode::Enabled);
    assert_eq!(
        router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
        Route::Generate
    );
    assert_eq!(
        router
            .route(Consumer::Digest, &run(), &digest(), &digest())
            .await,
        Route::Skip
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    let router = super::Router::new(Some(fake), "test".into(), Mode::Enabled, Mode::Off);
    assert_eq!(
        router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
        Route::Skip
    );
}

#[tokio::test]
async fn structural_changes_and_reminders_never_reach_skip_evaluation() {
    let fake = Fake::new("skip");
    let router = router(fake.clone(), Mode::Enabled);
    for key in [
        "removedSourceIds",
        "calendarEvents",
        "removedCalendarEventIds",
        "existingTasks",
        "removedTaskIds",
        "newlyDueReminderIds",
        "futureChangeKind",
    ] {
        let mut input = digest();
        input["changes"][key] = json!(["changed"]);
        assert_eq!(
            router.route(Consumer::Digest, &run(), &input, &input).await,
            Route::Generate,
            "{key}"
        );
    }
    for (key, value) in [
        ("partial", json!(true)),
        ("previous", Value::Null),
        ("changes", Value::Null),
    ] {
        let mut input = digest();
        input[key] = value;
        assert_eq!(
            router.route(Consumer::Digest, &run(), &input, &input).await,
            Route::Generate
        );
    }
    let mut edited = digest();
    edited["changes"]["sources"][0]["version"] = json!(2);
    assert_eq!(
        router
            .route(Consumer::Digest, &run(), &edited, &edited)
            .await,
        Route::Generate
    );
    let mut prefs = digest();
    prefs["changes"]["preferencesChanged"] = json!(true);
    assert_eq!(
        router.route(Consumer::Digest, &run(), &prefs, &prefs).await,
        Route::Generate
    );
    for hook in ["card_changed", "t_minus_2h", "t_minus_24h", "unknown"] {
        let mut input = pip();
        input["hooks"][0]["name"] = json!(hook);
        assert_eq!(
            router.route(Consumer::Pip, &run(), &input, &input).await,
            Route::Generate
        );
    }
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tool_targets_are_selected_from_current_scope() {
    let fake = Fake::new("read_session");
    let router = router(fake, Mode::Enabled);
    assert_eq!(
        router
            .route(Consumer::Digest, &run(), &digest(), &digest())
            .await,
        Route::ReadSession {
            session_id: "s1".into()
        }
    );
    let fake = Fake::new("plan_card");
    let router = super::Router::new(Some(fake), "test".into(), Mode::Enabled, Mode::Enabled);
    assert_eq!(
        router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
        Route::PlanCard {
            action: "rsvp".into()
        }
    );
    let fake = Fake::new("bash");
    let router = super::Router::new(Some(fake), "test".into(), Mode::Enabled, Mode::Enabled);
    assert_eq!(
        router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
        Route::Generate
    );
}

#[tokio::test]
async fn cache_is_scoped_to_account_source_content_and_policy_input() {
    let fake = Fake::new("skip");
    let router = router(fake.clone(), Mode::Enabled);
    let input = digest();
    for _ in 0..2 {
        assert_eq!(
            router.route(Consumer::Digest, &run(), &input, &input).await,
            Route::Skip
        );
    }
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    let mut other = run();
    other.owner_account_id = "another".into();
    router.route(Consumer::Digest, &other, &input, &input).await;
    let mut changed = input.clone();
    changed["sources"][0]["text"] = json!("Different context");
    router
        .route(Consumer::Digest, &run(), &changed, &changed)
        .await;
    let mut revoked = input.clone();
    revoked["sources"] = json!([]);
    router
        .route(Consumer::Digest, &run(), &revoked, &revoked)
        .await;
    assert_eq!(fake.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn failures_open_circuit_and_timeouts_fall_back() {
    let fake = Arc::new(Fake {
        fails: true,
        ..Arc::try_unwrap(Fake::new("skip")).ok().unwrap()
    });
    let router = router(fake.clone(), Mode::Enabled);
    for _ in 0..5 {
        assert_eq!(
            router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
            Route::Generate
        );
    }
    assert_eq!(fake.calls.load(Ordering::SeqCst), 3);
    let fake = Arc::new(Fake {
        delay: Duration::from_secs(1),
        ..Arc::try_unwrap(Fake::new("skip")).ok().unwrap()
    });
    let mut router = super::Router::new(Some(fake), "test".into(), Mode::Enabled, Mode::Enabled);
    router.deadline = Duration::from_millis(5);
    assert_eq!(
        router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
        Route::Generate
    );
}

#[tokio::test]
async fn oversized_input_bypasses_evaluation_without_truncating_evidence() {
    let fake = Fake::new("skip");
    let router = router(fake.clone(), Mode::Enabled);
    let mut input = pip();
    input["messages"][0]["text"] = json!("x".repeat(50_000));
    assert_eq!(
        router.route(Consumer::Pip, &run(), &input, &input).await,
        Route::Generate
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn response_contract_rejects_mismatches_and_invalid_probabilities() {
    let request = EvaluationRequest {
        state: json!({}),
        questions: BTreeMap::from([(
            "route".into(),
            Question::Choice {
                instructions: "choose".into(),
                criteria: BTreeMap::from([
                    ("skip".into(), "".into()),
                    ("generate".into(), "".into()),
                ]),
            },
        )]),
    };
    let valid = json!({"model":"test","usage":{"input_tokens":1,"output_tokens":0},"answers":{"route":{"type":"choice","choice":"skip","probabilities":{"skip":0.99,"generate":0.01},"confidence":0.99}}});
    let check = |value| {
        serde_json::from_value::<EvaluationResponse>(value)
            .unwrap()
            .validate(&request)
    };
    assert!(check(valid.clone()).is_ok());
    let mut wrong = valid.clone();
    wrong["answers"]["route"]["choice"] = json!("invented");
    assert!(check(wrong).is_err());
    let mut wrong = valid.clone();
    wrong["answers"]["route"]["probabilities"]["skip"] = json!(1.5);
    assert!(check(wrong).is_err());
    let mut wrong = valid.clone();
    wrong["answers"]["route"]["probabilities"]["generate"] = json!(0.5);
    assert!(check(wrong).is_err());
    let mut wrong = valid;
    wrong["answers"] = json!({});
    assert!(check(wrong).is_err());
}

use crate::client::{CloudAgentRunClient, ProviderAuthMaterial, RunnerClientError};
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall, OpenAiProviderConfig,
};

struct Model {
    calls: AtomicUsize,
    expected_tool: Option<&'static str>,
    plan_action: bool,
}
#[async_trait]
impl CloudModelProvider for Model {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(expected) = self.expected_tool {
            assert_eq!(messages[2]["tool_calls"][0]["function"]["name"], expected);
            assert_eq!(messages[3]["name"], expected);
            assert_eq!(messages[3]["role"], "tool");
            assert_eq!(tools.len(), 2, "Read-only observation remains available");
            if expected == "read_session" {
                let result: Value =
                    serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
                assert_eq!(result["sources"][0]["sessionId"], "s1");
            }
        }
        if self.plan_action && call == 0 {
            assert!(messages[2]["content"].as_str().unwrap().contains("rsvp"));
            assert_eq!(tools[0]["function"]["name"], "plan_card");
            return Ok(ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "planner-call".into(),
                name: "plan_card".into(),
                arguments: json!({"action":"rsvp","eventId":"event","participantId":"member","rsvp":"no"}),
            }]));
        }
        Ok(ModelProviderResponse::FinalText("{}".into()))
    }
}
struct Client {
    mutations: AtomicUsize,
}
#[async_trait]
impl CloudAgentRunClient for Client {
    async fn export_artifact(
        &self,
        _: &str,
        _: crate::client::ArtifactExportInput,
    ) -> Result<crate::client::ArtifactExportResponse, RunnerClientError> {
        panic!("routing must not export artifacts")
    }

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
    async fn plan_card_action(
        &self,
        run_id: &str,
        arguments: Value,
    ) -> Result<Value, RunnerClientError> {
        assert_eq!(run_id, "pip_test");
        assert_eq!(arguments["rsvp"], "no");
        self.mutations.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"ok":true}))
    }
}
fn material() -> ProviderAuthMaterial {
    ProviderAuthMaterial {
        snapshot_id: "fixture".into(),
        provider: "openai".into(),
        auth_choice: "default".into(),
        payload: json!({"apiKey":"fixture","model":"test"}),
    }
}
fn model() -> Model {
    Model {
        calls: AtomicUsize::new(0),
        expected_tool: None,
        plan_action: false,
    }
}

#[tokio::test]
async fn skipped_consumers_make_zero_generation_or_mutation_calls() {
    let router = router(Fake::new("skip"), Mode::Enabled);
    let model = model();
    let client = Client {
        mutations: AtomicUsize::new(0),
    };
    let mut run = run();
    run.prompt = digest().to_string();
    let output = crate::digest::run_with_router(&model, &run, material(), &router)
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["removedItemIds"], json!([]));
    assert_eq!(value["claims"], json!([]));
    run.run_id = "pip_test".into();
    run.prompt = pip().to_string();
    let output = crate::pip::run_with_router(&client, &model, &run, material(), &router)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap()["message"],
        Value::Null
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    assert_eq!(client.mutations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn selected_digest_tools_execute_before_first_generation() {
    for selected in ["read_session", "search_sessions"] {
        let router = router(Fake::new(selected), Mode::Enabled);
        let model = Model {
            expected_tool: Some(selected),
            ..model()
        };
        let mut run = run();
        run.prompt = digest().to_string();
        crate::digest::run_with_router(&model, &run, material(), &router)
            .await
            .unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn pip_selected_action_still_goes_through_the_planner_and_bound_client() {
    let router = router(Fake::new("plan_card"), Mode::Enabled);
    let model = Model {
        plan_action: true,
        ..model()
    };
    let client = Client {
        mutations: AtomicUsize::new(0),
    };
    let mut run = run();
    run.run_id = "pip_test".into();
    run.prompt = pip().to_string();
    crate::pip::run_with_router(&client, &model, &run, material(), &router)
        .await
        .unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    assert_eq!(client.mutations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shadow_uses_the_original_digest_prompt_and_tools() {
    let router = router(Fake::new("read_session"), Mode::Shadow);
    let model = model();
    let mut run = run();
    run.prompt = digest().to_string();
    crate::digest::run_with_router(&model, &run, material(), &router)
        .await
        .unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_evaluation_releases_capacity_and_does_not_cache() {
    let fake = Arc::new(Fake {
        delay: Duration::from_secs(10),
        ..Arc::try_unwrap(Fake::new("skip")).ok().unwrap()
    });
    let router = router(fake.clone(), Mode::Enabled);
    assert!(tokio::time::timeout(
        Duration::from_millis(5),
        router.route(Consumer::Pip, &run(), &pip(), &pip())
    )
    .await
    .is_err());
    assert_eq!(router.capacity.available_permits(), 4);
    assert!(router.health.lock().unwrap().cache.is_empty());
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn expired_cache_and_open_circuit_recover() {
    let fake = Fake::new("skip");
    let router = router(fake.clone(), Mode::Enabled);
    router.route(Consumer::Pip, &run(), &pip(), &pip()).await;
    {
        let mut health = router.health.lock().unwrap();
        for entry in health.cache.values_mut() {
            entry.expires = Instant::now() - Duration::from_secs(1);
        }
        health.failures = 3;
        health.open_until = Some(Instant::now() - Duration::from_secs(1));
    }
    assert_eq!(
        router.route(Consumer::Pip, &run(), &pip(), &pip()).await,
        Route::Skip
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    assert_eq!(router.health.lock().unwrap().failures, 0);
}

#[test]
fn digest_evaluation_includes_surrounding_thread_for_short_replies() {
    let mut input = digest();
    input["sources"].as_array_mut().unwrap().push(json!({"id":"proposal","sessionId":"s1","text":"Can you attend the review tomorrow?","version":1}));
    let Some(policy::Plan::Evaluate { request, .. }) =
        policy::plan(Consumer::Digest, &input, &input)
    else {
        panic!("evaluation expected")
    };
    assert_eq!(request.state["threadContext"].as_array().unwrap().len(), 2);
    assert!(request.state.to_string().contains("Can you attend"));
}

#[test]
fn boolean_and_score_answers_validate_against_their_own_rubrics() {
    let request = EvaluationRequest {
        state: json!({}),
        questions: BTreeMap::from([
            (
                "material".into(),
                Question::Noul {
                    instructions: "Material?".into(),
                },
            ),
            (
                "priority".into(),
                Question::Score {
                    instructions: "Priority?".into(),
                    criteria: vec!["low".into(), "high".into()],
                },
            ),
        ]),
    };
    let valid = json!({"model":"test","usage":{"input_tokens":1,"output_tokens":0},"answers":{
        "material":{"type":"noul","noul":0.7},
        "priority":{"type":"score","score":0.8,"legend":{"0":"low","1":"high"},"probabilities":{"0":0.2,"1":0.8},"confidence":0.7}}});
    let parse = |v| serde_json::from_value::<EvaluationResponse>(v).unwrap();
    assert!(parse(valid.clone()).validate(&request).is_ok());
    let mut wrong = valid.clone();
    wrong["answers"]["material"]["noul"] = json!(-0.1);
    assert!(parse(wrong).validate(&request).is_err());
    let mut wrong = valid.clone();
    wrong["answers"]["priority"]["score"] = json!(2);
    assert!(parse(wrong).validate(&request).is_err());
    let mut wrong = valid;
    wrong["answers"]["priority"]["legend"]["1"] = json!("unrelated");
    assert!(parse(wrong).validate(&request).is_err());
}

#[tokio::test]
async fn concurrency_queue_is_bounded_and_cancelled_waiters_do_not_leak_permits() {
    let fake = Arc::new(Fake {
        delay: Duration::from_secs(10),
        ..Arc::try_unwrap(Fake::new("skip")).ok().unwrap()
    });
    let router = Arc::new(router(fake.clone(), Mode::Enabled));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let router = router.clone();
        tasks.spawn(async move { router.route(Consumer::Pip, &run(), &pip(), &pip()).await });
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while fake.calls.load(Ordering::SeqCst) < 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 4);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    assert_eq!(router.capacity.available_permits(), 4);
}

struct FailedEvaluation {
    error: EvaluationError,
    stall: bool,
}
#[async_trait]
impl EvaluationProvider for FailedEvaluation {
    async fn evaluate(&self, _: &EvaluationRequest) -> Result<EvaluationResponse, EvaluationError> {
        if self.stall {
            std::future::pending::<()>().await;
        }
        Err(self.error)
    }
}
struct FallbackPlanner {
    calls: AtomicUsize,
}
#[async_trait]
impl CloudModelProvider for FallbackPlanner {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "plan_card");
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            assert_eq!(
                messages.len(),
                2,
                "Fallback must use the original PiP prompt without a Jev hint"
            );
            return Ok(ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "fallback-rsvp".into(),
                name: "plan_card".into(),
                arguments: json!({"action":"rsvp","eventId":"event","participantId":"member","rsvp":"no"}),
            }]));
        }
        assert_eq!(messages[3]["tool_call_id"], "fallback-rsvp");
        Ok(ModelProviderResponse::FinalText(
            r#"{"message":"Your RSVP is updated.","hooksHandled":[]}"#.into(),
        ))
    }
}

#[tokio::test]
async fn failed_jev_preserves_pip_generation_plan_card_execution_and_reply() {
    for (case, error, stall, missing, circuit) in [
        (
            "rate_limit",
            EvaluationError::Http(429),
            false,
            false,
            false,
        ),
        (
            "upstream_failure",
            EvaluationError::Http(503),
            false,
            false,
            false,
        ),
        (
            "invalid_reply",
            EvaluationError::Invalid,
            false,
            false,
            false,
        ),
        (
            "network_failure",
            EvaluationError::Unavailable,
            false,
            false,
            false,
        ),
        ("deadline", EvaluationError::Timeout, true, false, false),
        (
            "missing_key",
            EvaluationError::Unavailable,
            false,
            true,
            false,
        ),
        (
            "open_circuit",
            EvaluationError::Unavailable,
            false,
            false,
            true,
        ),
    ] {
        let evaluator = (!missing)
            .then(|| Arc::new(FailedEvaluation { error, stall }) as Arc<dyn EvaluationProvider>);
        let mut router = Router::new(evaluator, "test".into(), Mode::Enabled, Mode::Enabled);
        router.deadline = Duration::from_millis(5);
        if circuit {
            router.health.lock().unwrap().open_until =
                Some(Instant::now() + Duration::from_secs(30));
        }
        let planner = FallbackPlanner {
            calls: AtomicUsize::new(0),
        };
        let client = Client {
            mutations: AtomicUsize::new(0),
        };
        let mut run = run();
        run.run_id = "pip_test".into();
        run.prompt = pip().to_string();
        let output = crate::pip::run_with_router(&client, &planner, &run, material(), &router)
            .await
            .unwrap();
        assert_eq!(planner.calls.load(Ordering::SeqCst), 2, "{case}");
        assert_eq!(client.mutations.load(Ordering::SeqCst), 1, "{case}");
        assert_eq!(
            serde_json::from_str::<Value>(&output).unwrap()["message"],
            "Your RSVP is updated.",
            "{case}"
        );
        println!("fallback case={case} planner_calls=2 plan_card_calls=1 reply=completed");
    }
}
