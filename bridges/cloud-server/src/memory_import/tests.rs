//! Memory import extraction. Reply parsing and request checks run without a
//! database; the route tests run against a real Postgres at `$DATABASE_URL`
//! (skipped when unset) and a fake OpenAI-compatible model on loopback.

use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tower::util::ServiceExt;

use super::*;
use crate::auth::password::PasswordHasherConfig;
use crate::auth::rate_limit::{
    BudgetOverrides, CloudRateLimiter, RateLimitDecision, MEMORY_IMPORT_EXTRACT_LIMIT,
};
use crate::resource_pools::{PoolLimits, ResourcePool};
use crate::server::ServerState;
use crate::system_agent::{SystemAgentProviderAuth, SystemAgentService};

const ROUTE: &str = "/v1/cloud/memory/import/extract";

fn request(text: &str) -> ExtractRequest {
    ExtractRequest {
        file_name: "AGENTS.md".into(),
        text: text.into(),
        existing_memories: Vec::new(),
    }
}

#[test]
fn a_reply_keeps_twelve_checked_memories_and_falls_back_by_scope() {
    let entries: Vec<Value> = (0..20)
        .map(|index| json!({"text": format!("Rule {index}."), "category": "hcp-custom:task_lessons", "scope": "project"}))
        .collect();
    let memories = parse_reply(&json!({ "memories": entries }).to_string()).unwrap();
    assert_eq!(memories.len(), MAX_MEMORIES_PER_FILE);
    assert_eq!(memories[0].text, "Rule 0.");

    let reply = format!(
        "Here you go:\n```json\n{}\n```",
        json!({"memories": [
            {"text": "  Answer   in British English. ", "category": "general_preferences", "scope": "global"},
            {"text": "Use pnpm.", "category": "made_up"},
            {"text": "Prefer metric units.", "category": "made_up", "scope": "global"},
            {"text": ""},
            {"text": "x".repeat(MEMORY_MAX_CHARS + 1)},
            {"category": "work_context"},
        ]})
    );
    assert_eq!(
        parse_reply(&reply).unwrap(),
        vec![
            ExtractedMemory {
                text: "Answer in British English.".into(),
                category: "general_preferences".into(),
                scope: "global".into()
            },
            ExtractedMemory {
                text: "Use pnpm.".into(),
                category: "hcp-custom:task_lessons".into(),
                scope: "project".into()
            },
            ExtractedMemory {
                text: "Prefer metric units.".into(),
                category: "general_preferences".into(),
                scope: "global".into()
            },
        ]
    );
    assert_eq!(parse_reply("no json here"), None);
    assert_eq!(parse_reply("{\"items\":[]}"), None);
}

#[test]
fn requests_are_checked_before_anything_is_counted() {
    assert_eq!(request("- Use pnpm.").validate(), Ok(()));
    assert_eq!(
        request("x".repeat(MAX_IMPORT_TEXT_BYTES).as_str()).validate(),
        Ok(())
    );
    assert_eq!(
        request("x".repeat(MAX_IMPORT_TEXT_BYTES + 1).as_str()).validate(),
        Err(ExtractError::TextTooLarge)
    );
    assert_eq!(request(" \n ").validate(), Err(ExtractError::EmptyText));
    let mut unnamed = request("text");
    unnamed.file_name = "  ".into();
    assert_eq!(unnamed.validate(), Err(ExtractError::InvalidFileName));
    let mut crowded = request("text");
    crowded.existing_memories = vec!["memory".into(); MAX_EXISTING_MEMORIES + 1];
    assert_eq!(
        crowded.validate(),
        Err(ExtractError::TooManyExistingMemories)
    );
}

#[tokio::test]
async fn the_extract_budget_allows_sixty_an_hour_per_account() {
    assert_eq!(MEMORY_IMPORT_EXTRACT_LIMIT.limit, 60);
    assert_eq!(MEMORY_IMPORT_EXTRACT_LIMIT.window.as_secs(), 3600);
    let limiter = CloudRateLimiter::default();
    for _ in 0..60 {
        assert_eq!(
            limiter
                .observe_account_limit(MEMORY_IMPORT_EXTRACT_LIMIT, "acct_import_a")
                .await,
            RateLimitDecision::Allowed
        );
    }
    assert!(matches!(
        limiter
            .observe_account_limit(MEMORY_IMPORT_EXTRACT_LIMIT, "acct_import_a")
            .await,
        RateLimitDecision::Limited { .. }
    ));
    assert_eq!(
        limiter
            .observe_account_limit(MEMORY_IMPORT_EXTRACT_LIMIT, "acct_import_b")
            .await,
        RateLimitDecision::Allowed,
        "each account has its own budget"
    );
}

/// What the fake model received, and the reply it gives.
#[derive(Clone, Default)]
struct FakeModel {
    seen: Arc<Mutex<Vec<Value>>>,
}

async fn fake_completion(State(model): State<FakeModel>, Json(body): Json<Value>) -> Json<Value> {
    model.seen.lock().unwrap().push(body);
    let memories: Vec<Value> = (0..15)
        .map(|index| json!({"text": format!("Synthetic rule {index}."), "category": "hcp-custom:task_lessons", "scope": "project"}))
        .collect();
    Json(
        json!({"choices": [{"message": {"role": "assistant", "content": json!({"memories": memories}).to_string()}}]}),
    )
}

struct Fixture {
    db: PgPool,
    router: Router,
    model: FakeModel,
    account_id: String,
    token: String,
    _server: tokio::task::JoinHandle<()>,
}

async fn fixture(grounding_per_person: Option<u32>, budgets: &str) -> Option<Fixture> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let db = crate::pg::init_pool(&url).await.expect("init test pool");
    let model = FakeModel::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/v1", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/v1/chat/completions", post(fake_completion))
        .with_state(model.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_memimport_{suffix}");
    let device_id = format!("dev_memimport_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Import', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(&db)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Import device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(&db)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(&db, &account_id, &device_id, 30)
        .await
        .unwrap();

    let service_account = format!("acct_memimport_service_{suffix}");
    let config = crate::system_agent::test_config(&service_account);
    let auth = SystemAgentProviderAuth::openai_api_key("synthetic-key", "synthetic-model")
        .unwrap()
        .with_base_url(origin);
    let pool = ResourcePool::new(format!("memimport-{suffix}"), PoolProvider::new(auth))
        .with_limits(PoolLimits {
            grounding_runs_per_person: grounding_per_person,
            ..PoolLimits::default()
        });
    config
        .resource_pool_registry()
        .replace(ResourcePools::single(pool));
    let state = Arc::new(
        ServerState::new(db.clone(), crate::events::EventBus::noop())
            .with_system_agent(SystemAgentService::new(config)),
    );
    let limiter =
        CloudRateLimiter::default().with_budget_overrides(BudgetOverrides::parse(budgets).unwrap());
    let router =
        crate::auth::routes::routes_with_config(state, PasswordHasherConfig::for_tests(), limiter);
    Some(Fixture {
        db,
        router,
        model,
        account_id,
        token: session.plaintext_token,
        _server: server,
    })
}

impl Fixture {
    async fn consent(&self, status: &str) {
        query("UPDATE cloud_accounts SET ai_consent_status = $2 WHERE account_id = $1")
            .bind(&self.account_id)
            .bind(status)
            .execute(&self.db)
            .await
            .unwrap();
    }

    async fn extract(&self, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(ROUTE)
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn calls(&self) -> usize {
        self.model.seen.lock().unwrap().len()
    }
}

fn file(text: &str) -> Value {
    json!({"fileName": "AGENTS.md", "text": text, "existingMemories": ["Synthetic existing memory."]})
}

#[tokio::test]
async fn extraction_needs_allowed_ai_and_never_reaches_the_model_otherwise() {
    let Some(fixture) = fixture(None, "").await else {
        return;
    };
    for status in ["unset", "declined"] {
        fixture.consent(status).await;
        let (code, body) = fixture.extract(file("- Use pnpm.")).await;
        assert_eq!(code, StatusCode::FORBIDDEN, "{status}");
        assert_eq!(body["errorCode"], crate::ai_consent::AI_CONSENT_REQUIRED);
    }
    assert_eq!(fixture.calls(), 0, "no text reached the model");

    fixture.consent("allowed").await;
    let (code, body) = fixture.extract(file("- Use pnpm.")).await;
    assert_eq!(code, StatusCode::OK);
    let memories = body["memories"].as_array().unwrap();
    assert_eq!(
        memories.len(),
        MAX_MEMORIES_PER_FILE,
        "the model's 15 are capped at 12"
    );
    assert_eq!(
        memories[0],
        json!({"text": "Synthetic rule 0.", "category": "hcp-custom:task_lessons", "scope": "project"})
    );
    let seen = fixture.model.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["model"], "synthetic-model");
    assert_eq!(
        seen[0]["messages"][0]["content"],
        MEMORY_IMPORT_SYSTEM_PROMPT
    );
    let prompt = seen[0]["messages"][1]["content"].as_str().unwrap();
    assert!(prompt.contains("- Synthetic existing memory."));
    assert!(prompt.contains(
        "App: Chosen files\nFile: AGENTS.md\nProject: Chosen files\n<<<FILE\n- Use pnpm.\nFILE>>>"
    ));
}

#[tokio::test]
async fn oversized_text_is_refused_before_the_model_or_the_budget() {
    let Some(fixture) = fixture(None, "memory-import-extract=1/1h").await else {
        return;
    };
    fixture.consent("allowed").await;
    let (code, body) = fixture
        .extract(file(&"x".repeat(MAX_IMPORT_TEXT_BYTES + 1)))
        .await;
    assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["errorCode"], "memory_import_too_large");
    assert_eq!(fixture.calls(), 0);
    let (code, _) = fixture.extract(file("- Use pnpm.")).await;
    assert_eq!(
        code,
        StatusCode::OK,
        "the refused request did not spend the budget"
    );
}

#[tokio::test]
async fn the_rate_limit_and_the_daily_pool_limit_refuse_further_extractions() {
    let Some(fixture) = fixture(None, "memory-import-extract=2/1h").await else {
        return;
    };
    fixture.consent("allowed").await;
    for _ in 0..2 {
        assert_eq!(fixture.extract(file("- Use pnpm.")).await.0, StatusCode::OK);
    }
    let (code, body) = fixture.extract(file("- Use pnpm.")).await;
    assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["errorCode"], "rate_limited");
    assert_eq!(fixture.calls(), 2);

    let Some(limited) = fixture_with_pool_limit().await else {
        return;
    };
    limited.consent("allowed").await;
    assert_eq!(limited.extract(file("- Use pnpm.")).await.0, StatusCode::OK);
    let (code, body) = limited.extract(file("- Use pnpm.")).await;
    assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["errorCode"], "memory_import_limit");
    assert_eq!(
        limited.calls(),
        1,
        "the refused extraction never reached the model"
    );
    let day = crate::resource_pools::usage::usage_day();
    let counted: i64 = sqlx_core::query_scalar::query_scalar(
        "SELECT runs FROM cloud_resource_pool_usage WHERE usage_day = $1 AND feature = 'grounding' AND scope_id = $2",
    )
    .bind(day)
    .bind(&limited.account_id)
    .fetch_one(&limited.db)
    .await
    .unwrap();
    assert_eq!(
        counted, 1,
        "one extraction is counted against the person's daily runs"
    );
}

async fn fixture_with_pool_limit() -> Option<Fixture> {
    fixture(Some(1), "").await
}
