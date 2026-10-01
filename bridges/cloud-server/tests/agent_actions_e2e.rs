//! End-to-end checks for actions that need a person (calendar sharing
//! approval, PiP suggestions), reply disclosure, and the side effects of AI
//! access notices.
//!
//! Skipped when `DATABASE_URL` is not set. Every account and conversation is
//! synthetic and unique to the test that creates it.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::chat_sync::models::SendMessageRequest;
use kordi_cloud_server::chat_sync::store as chat_store;
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::pip::{
    bootstrap_pip_agent, PendingPipConfig, PipConfig, PipProviderAuth, PipService,
};
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tower::util::ServiceExt;
use uuid::Uuid;

static INIT_POOL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PIP: tokio::sync::OnceCell<PipConfig> = tokio::sync::OnceCell::const_new();
const RUNNER_TOKEN: &str = "agent-actions-runner-token";
const RUNNER_ID: &str = "agent-actions-runner";

#[derive(Clone, Debug)]
struct TestAccount {
    account_id: String,
    token: String,
}

async fn try_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let _guard = INIT_POOL_LOCK.lock().await;
    Some(
        init_pool(&url)
            .await
            .expect("configured test database must migrate successfully"),
    )
}

/// One synthetic PiP account for the whole test binary: the service account
/// is registered process-wide the first time PiP starts.
async fn pip_config(pool: &PgPool) -> PipConfig {
    PIP.get_or_init(|| async {
        let suffix = Uuid::new_v4().simple().to_string();
        let pending = PendingPipConfig {
            account_id: format!("acct_pip_actions_{suffix}"),
            owner_email: format!("pip-{suffix}@agent-actions.example.test"),
            agent_id: format!("cloud_agent_pip_actions_{suffix}"),
            name: "PiP".to_string(),
            subtitle: "Keeps plans in this chat honest".to_string(),
            provider_auth: PipProviderAuth::openai_api_key("synthetic-test-key", "synthetic-model")
                .unwrap(),
        };
        bootstrap_pip_agent(pool, pending)
            .await
            .expect("bootstrap synthetic PiP")
    })
    .await
    .clone()
}

fn test_router(state: ServerState) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
        per_email_global_failure_limit: 50,
    });
    router_with_rate_limiter(Arc::new(state), limiter)
}

fn request(method: &str, uri: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn call(router: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, body)
}

async fn signup(router: &axum::Router, prefix: &str, display_name: &str) -> TestAccount {
    let email = format!(
        "{prefix}-{}@agent-actions.example.test",
        Uuid::new_v4().simple()
    );
    let (status, body) = call(
        router,
        request(
            "POST",
            "/v1/cloud/auth/signup",
            None,
            Some(json!({"email": email, "password": "correct horse",
                "displayName": display_name, "avatarSeed": "agent_actions"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    TestAccount {
        account_id: body["account"]["accountId"].as_str().unwrap().to_string(),
        token: body["session"]["token"].as_str().unwrap().to_string(),
    }
}

async fn accept_contacts(router: &axum::Router, from: &TestAccount, to: &TestAccount) {
    let (status, body) = call(
        router,
        request(
            "POST",
            "/v1/cloud/contacts/requests",
            Some(&from.token),
            Some(json!({ "peerAccountId": to.account_id })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let request_id = body["request"]["requestId"].as_str().unwrap();
    let (status, _) = call(
        router,
        request(
            "POST",
            &format!("/v1/cloud/contacts/requests/{request_id}/accept"),
            Some(&to.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

/// A group of three, the owner's agent, and an outsider who is never a
/// member.
struct Group {
    router: axum::Router,
    pool: PgPool,
    owner: TestAccount,
    requester: TestAccount,
    member: TestAccount,
    outsider: TestAccount,
    session: String,
    conversation: Uuid,
    pip: Option<PipConfig>,
    tag: String,
}

impl Group {
    async fn new(prefix: &str, with_pip: bool) -> Option<Self> {
        let pool = try_pool().await?;
        let mut state = ServerState::new(pool.clone(), EventBus::noop());
        let pip = if with_pip {
            let config = pip_config(&pool).await;
            state = state.with_pip(PipService::new(config.clone()));
            Some(config)
        } else {
            None
        };
        let router = test_router(state);
        let owner = signup(&router, &format!("{prefix}-owner"), "Olive Owner").await;
        let requester = signup(&router, &format!("{prefix}-requester"), "Riley Requester").await;
        let member = signup(&router, &format!("{prefix}-member"), "Morgan Member").await;
        let outsider = signup(&router, &format!("{prefix}-outsider"), "Oscar Outsider").await;
        for peer in [&requester, &member] {
            accept_contacts(&router, &owner, peer).await;
        }
        let session = format!("session:group:{}", Uuid::new_v4());
        let (status, body) = call(
            &router,
            request(
                "POST",
                "/v2/chat/conversations",
                Some(&owner.token),
                Some(json!({
                    "client_operation_id": Uuid::new_v4(),
                    "kind": "group",
                    "shared_title": "Weekend plans",
                    "client_session_id": session,
                    "member_account_ids": [requester.account_id, member.account_id],
                })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let conversation = Uuid::parse_str(body["conversation"]["id"].as_str().unwrap()).unwrap();
        Some(Self {
            router,
            pool,
            owner,
            requester,
            member,
            outsider,
            session,
            conversation,
            pip,
            tag: Uuid::new_v4().simple().to_string()[..12].to_string(),
        })
    }

    fn agent(&self) -> String {
        format!("cloud-agent:{}", self.owner.account_id)
    }

    fn encoded_session(&self) -> String {
        self.session.replace(':', "%3A")
    }

    /// Stores a group message from `sender` and returns its server id.
    async fn post(&self, sender: &TestAccount, message: Value) -> String {
        let participants: Vec<Value> = [&self.owner, &self.requester, &self.member]
            .iter()
            .map(|account| json!({"accountId": account.account_id, "displayName": "Member"}))
            .collect();
        let envelope = json!({
            "kind": "group-message", "groupId": self.session, "groupSpaceId": self.session,
            "groupTitle": null, "createdByAccountId": self.owner.account_id,
            "actor": {"accountId": sender.account_id, "displayName": "Member"},
            "participants": participants, "message": message,
        });
        let body = format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        chat_store::send_message(
            &self.pool,
            &sender.account_id,
            self.conversation,
            SendMessageRequest {
                client_message_id: Uuid::now_v7(),
                kind: "text".to_string(),
                content: json!({"schema": 1, "blocks": [{"type": "text", "text": body}]}),
                reply_to_message_id: None,
                attachment_ids: Vec::new(),
            },
        )
        .await
        .expect("store group message")
        .value
        .id
        .to_string()
    }

    /// A request to the owner's default agent.
    async fn ask(&self, sender: &TestAccount, id: &str, text: &str) -> String {
        self.post(
            sender,
            json!({"id": id, "senderAccountId": sender.account_id,
                "senderKind": "human", "text": format!("@Kordi {text}"),
                "createdAtMs": chrono::Utc::now().timestamp_millis(),
                "targetCloudAgentId": self.agent(),
                "targetCloudAgentOwnerAccountId": self.owner.account_id,
                "targetCloudAgentName": "Kordi"}),
        )
        .await
    }

    async fn set_ai_access(&self, actor: &TestAccount, change: Value) -> (StatusCode, Value) {
        let mut body = change;
        body["client_operation_id"] = json!(Uuid::new_v4());
        call(
            &self.router,
            request(
                "PUT",
                &format!(
                    "/v2/chat/conversations/{}/ai-access",
                    self.encoded_session()
                ),
                Some(&actor.token),
                Some(body),
            ),
        )
        .await
    }

    async fn actions(&self, account: &TestAccount) -> Vec<Value> {
        let (status, body) = call(
            &self.router,
            request(
                "GET",
                &format!(
                    "/v1/cloud/agent-actions?sessionId={}",
                    self.encoded_session()
                ),
                Some(&account.token),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["actions"].as_array().unwrap().clone()
    }

    async fn decide(
        &self,
        account: &TestAccount,
        action_id: &str,
        decision: &str,
    ) -> (StatusCode, Value) {
        call(
            &self.router,
            request(
                "POST",
                &format!("/v1/cloud/agent-actions/{action_id}/decision"),
                Some(&account.token),
                Some(json!({"decision": decision})),
            ),
        )
        .await
    }

    /// Accounts that received `agent_action.updated` for this action.
    async fn notified(&self, action_id: &str) -> Vec<String> {
        let rows: Vec<(String,)> = query_as(
            "SELECT DISTINCT account_id FROM cloud_chat_user_sync_events
             WHERE event_type = 'agent_action.updated'
               AND payload->'agentAction'->>'actionId' = $1
             ORDER BY account_id",
        )
        .bind(action_id)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter().map(|row| row.0).collect()
    }

    /// Hands a run to this test's runner and returns its run token.
    async fn lease_for_runner(&self, run_id: &str) -> String {
        let token = format!("run-token-{}", Uuid::new_v4().simple());
        let updated = query(
            "UPDATE cloud_agent_fallback_runs SET status='leased', claimed_by=$2,
                 lease_expires_at=(now()+interval '10 minutes')::text, runner_run_token_hash=$3
             WHERE run_id=$1",
        )
        .bind(run_id)
        .bind(RUNNER_ID)
        .bind(kordi_cloud_server::cloud_agent_runtime::runs::run_tokens::hash_run_token(&token))
        .execute(&self.pool)
        .await
        .unwrap();
        assert_eq!(updated.rows_affected(), 1);
        token
    }

    async fn runner_post(
        &self,
        run_id: &str,
        run_token: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = request(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/{path}"),
            Some(RUNNER_TOKEN),
            Some(body),
        );
        request
            .headers_mut()
            .insert("x-kordi-run-token", run_token.parse().unwrap());
        call(&self.router, request).await
    }
}

#[path = "agent_actions_e2e/calendar.rs"]
mod calendar;
#[path = "agent_actions_e2e/disclosure.rs"]
mod disclosure;
#[path = "agent_actions_e2e/notices.rs"]
mod notices;
#[path = "agent_actions_e2e/plan_suggestions.rs"]
mod plan_suggestions;
