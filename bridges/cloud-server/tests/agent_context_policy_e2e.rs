//! End-to-end checks for per-conversation AI access: settings and notices,
//! the context policy on every server read path, the desktop executor
//! context contract, and the authority checks runs keep.
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
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tower::util::ServiceExt;
use uuid::Uuid;

static INIT_POOL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const RUNNER_TOKEN: &str = "agent-context-policy-runner-token";
const RUNNER_ID: &str = "agent-context-policy-runner";

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

fn test_router(pool: &PgPool) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
        per_email_global_failure_limit: 50,
    });
    router_with_rate_limiter(
        Arc::new(ServerState::new(pool.clone(), EventBus::noop())),
        limiter,
    )
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
        "{prefix}-{}@agent-context-policy.example.test",
        Uuid::new_v4().simple()
    );
    let (status, body) = call(
        router,
        request(
            "POST",
            "/v1/cloud/auth/signup",
            None,
            Some(json!({"email": email, "password": "correct horse",
                "displayName": display_name, "avatarSeed": "agent_context_policy"})),
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

/// A group of four: the agent owner, a requester, a member who will keep
/// their messages from other people's AI, and a second member.
struct Group {
    router: axum::Router,
    pool: PgPool,
    owner: TestAccount,
    requester: TestAccount,
    member: TestAccount,
    member2: TestAccount,
    session: String,
    conversation: Uuid,
    /// Unique per fixture, so text checks never match another test's data.
    tag: String,
}

impl Group {
    async fn new(prefix: &str) -> Option<Self> {
        let pool = try_pool().await?;
        let router = test_router(&pool);
        let owner = signup(&router, &format!("{prefix}-owner"), "Olive Owner").await;
        let requester = signup(&router, &format!("{prefix}-requester"), "Riley Requester").await;
        let member = signup(&router, &format!("{prefix}-member"), "Morgan Member").await;
        let member2 = signup(&router, &format!("{prefix}-member2"), "Max Member").await;
        for peer in [&requester, &member, &member2] {
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
                    "member_account_ids": [
                        requester.account_id, member.account_id, member2.account_id
                    ],
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
            member2,
            session,
            conversation,
            tag: Uuid::new_v4().simple().to_string()[..12].to_string(),
        })
    }

    fn agent(&self) -> String {
        format!("cloud-agent:{}", self.owner.account_id)
    }

    fn participants(&self) -> Value {
        Value::Array(
            [&self.owner, &self.requester, &self.member, &self.member2]
                .iter()
                .map(|account| json!({"accountId": account.account_id, "displayName": "Member"}))
                .collect(),
        )
    }

    /// Stores a group message from `sender` and returns its server id.
    async fn post(&self, sender: &TestAccount, message: Value) -> String {
        let envelope = json!({
            "kind": "group-message", "groupId": self.session, "groupSpaceId": self.session,
            "groupTitle": null, "createdByAccountId": self.owner.account_id,
            "actor": {"accountId": sender.account_id, "displayName": "Member"},
            "participants": self.participants(), "message": message,
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

    /// A member's ordinary message.
    async fn say(&self, sender: &TestAccount, id: &str, text: &str) -> String {
        self.post(
            sender,
            json!({"id": id, "senderAccountId": sender.account_id, "senderKind": "human",
                "text": text, "createdAtMs": chrono::Utc::now().timestamp_millis()}),
        )
        .await
    }

    /// A request to the owner's default agent, optionally replying to `reply_to`.
    async fn ask(
        &self,
        sender: &TestAccount,
        id: &str,
        text: &str,
        reply_to: Option<&str>,
    ) -> String {
        let mut message = json!({"id": id, "senderAccountId": sender.account_id,
            "senderKind": "human", "text": format!("@Kordi {text}"),
            "createdAtMs": chrono::Utc::now().timestamp_millis(),
            "targetCloudAgentId": self.agent(),
            "targetCloudAgentOwnerAccountId": self.owner.account_id,
            "targetCloudAgentName": "Kordi"});
        if let Some(reply_to) = reply_to {
            message["replyToMessageId"] = json!(reply_to);
        }
        self.post(sender, message).await
    }

    /// The owner's default agent answering `request_id`.
    async fn reply(&self, id: &str, request_id: &str, text: &str) -> String {
        self.post(
            &self.owner,
            json!({"id": id, "senderAccountId": self.owner.account_id, "senderKind": "agent",
                "senderAgentId": self.agent(), "requestId": request_id, "text": text,
                "deliveryState": "complete",
                "createdAtMs": chrono::Utc::now().timestamp_millis()}),
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
                    urlencoding_session(&self.session)
                ),
                Some(&actor.token),
                Some(body),
            ),
        )
        .await
    }

    /// Claims a cloud run for `requester`'s request and returns the run id.
    async fn claim_cloud(&self, requester: &TestAccount, request_id: &str) -> (StatusCode, Value) {
        call(
            &self.router,
            request(
                "POST",
                "/v1/cloud/agent-runs/claim",
                Some(&requester.token),
                Some(json!({
                    "requestMessageId": request_id, "sessionId": self.session,
                    "ownerAccountId": self.owner.account_id,
                    "requesterAccountId": requester.account_id,
                    "prompt": "@Kordi help",
                    "idempotencyKey": format!("{}:{request_id}:{}", self.session, self.owner.account_id),
                })),
            ),
        )
        .await
    }

    /// Hands a queued cloud run to this test's runner and returns its run token.
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

    async fn runner_read(
        &self,
        run_id: &str,
        run_token: &str,
        tool: &str,
        arguments: Value,
    ) -> (StatusCode, Value) {
        let mut request = request(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/context"),
            Some(RUNNER_TOKEN),
            Some(json!({"runnerId": RUNNER_ID, "tool": tool, "arguments": arguments})),
        );
        request
            .headers_mut()
            .insert("x-kordi-run-token", run_token.parse().unwrap());
        call(&self.router, request).await
    }

    async fn run_prompt(&self, run_id: &str) -> String {
        let (prompt,): (String,) =
            query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id=$1")
                .bind(run_id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        prompt
    }
}

/// Percent-encodes the characters a legacy session id uses in a path segment.
fn urlencoding_session(session: &str) -> String {
    session.replace(':', "%3A")
}

/// Message ids a read returned.
fn message_ids(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|message| message["messageId"].as_str().map(str::to_string))
        .collect()
}

#[path = "agent_context_policy_e2e/authority.rs"]
mod authority;
#[path = "agent_context_policy_e2e/cloud_context.rs"]
mod cloud_context;
#[path = "agent_context_policy_e2e/desktop_contract.rs"]
mod desktop_contract;
#[path = "agent_context_policy_e2e/settings.rs"]
mod settings;
