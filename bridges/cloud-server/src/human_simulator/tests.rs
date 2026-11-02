//! Explicitly isolated integration coverage: real HTTP, auth, sync and Postgres;
//! External models are scripted by default; a separate opt-in test uses the live provider.
//! No desktop App is involved.
#[path = "mutual_tests.rs"]
mod mutual;
#[path = "stop_tests.rs"]
mod stop;
use super::*;
use axum::{extract::State, routing::post, Json};
use futures_util::FutureExt;
use kordi_human_simulator::{
    client::{AccountCredentials, ApiClient},
    protocol::{ActorState, PendingSend},
    HUMAN_REQUESTER_SKILL,
};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use std::{panic::AssertUnwindSafe, sync::Mutex};
use tokio::{
    task::JoinHandle,
    time::{sleep, timeout},
};
use uuid::Uuid;

struct Tasks(Vec<JoinHandle<()>>);
impl Drop for Tasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}
async fn listen(app: Router, tasks: &mut Tasks) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tasks.0.push(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    origin
}
async fn model(State(seen): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>) -> Json<Value> {
    let context = body["messages"][1]["content"].as_str().unwrap();
    let decision = if context.contains("synthetic-peer-reply") {
        json!({"action":"finish","memory":"Peer replied; objective complete."})
    } else {
        json!({"action":"send","text":"Synthetic headless question?","memory":"Asked once."})
    };
    seen.lock().unwrap().push(body);
    Json(json!({"choices":[{"message":{"content":decision.to_string()}}]}))
}
async fn account(pool: &PgPool, id: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_accounts(account_id,display_name,avatar_url,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES ($1,'Synthetic simulator test','https://example.invalid/avatar.png',$2,$2,'uploaded','lorelei',$1,'dicebear-rust-10.6.0-styles-10.5.0',1,$2)")
        .bind(id).bind(&now).execute(pool).await.unwrap();
    let device = format!("sim-device-{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_devices(device_id,account_id,device_name,device_public_key,device_key_algorithm,authorization_state,confirmed_at,created_at,last_seen_at) VALUES ($1,$2,'Synthetic simulator','synthetic-key','legacy','confirmed',$3,$3,$3)")
        .bind(&device).bind(id).bind(&now).execute(pool).await.unwrap();
    crate::auth::session::issue_session(pool, id, &device, 1)
        .await
        .unwrap()
        .plaintext_token
}
async fn post_json(client: &reqwest::Client, url: String, token: &str, body: &Value) -> Value {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "HTTP request failed: {}",
        response.status()
    );
    response.json().await.unwrap()
}
fn message(id: Uuid, text: &str) -> Value {
    json!({"client_message_id":id,"kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":text}]},"reply_to_message_id":null,"attachment_ids":[]})
}
fn config(actor: &str, account: &str, conversation: Uuid) -> Value {
    json!({"actor_id":actor,"account_id":account,"conversation_id":conversation,
        "objective":"Ask once and finish after the peer replies.","persona":"Brief synthetic human",
        "private_facts":[],"skill":"human-requester@1","max_model_calls":5,"max_messages":3,
        "poll_seconds":1,"max_wait_seconds":5})
}
async fn wait_sent(pool: &PgPool, actor: &str) {
    loop {
        if store::get(pool, actor)
            .await
            .unwrap()
            .unwrap()
            .messages_sent
            == 1
        {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
}
async fn wait_finished(pool: &PgPool, actor: &str) {
    loop {
        if store::get(pool, actor).await.unwrap().unwrap().state["status"] == "finished" {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
}
fn launch(tasks: &mut Tasks, base: &str, actor: &str, worker_token: &str, account_token: &str) {
    let api = ApiClient::new(base, worker_token.into()).unwrap();
    let actor = actor.to_owned();
    let credentials = AccountCredentials {
        token: Some(account_token.into()),
        login: None,
    };
    tasks.0.push(tokio::spawn(async move {
        kordi_human_simulator::worker::run_configured(api, &actor, credentials)
            .await
            .expect("headless worker succeeds");
    }));
}

#[tokio::test]
#[ignore = "requires task-owned PostgreSQL"]
async fn real_http_headless_human_and_pending_send_recovery() {
    run_integration(None).await;
}

#[tokio::test]
#[ignore = "requires task-owned PostgreSQL and explicit live provider opt-in"]
async fn live_provider_real_http_headless_human() {
    assert!(
        std::env::var("KORDI_SIM_LIVE_MODEL_TEST").as_deref() == Ok("1"),
        "explicit live model opt-in required"
    );
    let provider = PendingSystemAgentConfig::from_env()
        .ok()
        .flatten()
        .expect("live system provider configuration required")
        .provider_auth;
    run_integration(Some(provider)).await;
}

async fn run_integration(provider: Option<SystemAgentProviderAuth>) {
    let url = std::env::var("KORDI_SIM_TEST_DATABASE_URL")
        .expect("explicit isolated simulator test database required");
    assert!(
        std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET").is_ok(),
        "test cursor signing secret required"
    );
    let pool = crate::pg::init_pool(&url).await.unwrap();
    store::initialize(&pool).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let accounts = [format!("sim-human-{suffix}"), format!("sim-peer-{suffix}")];
    let actors = [format!("sim-{suffix}"), format!("recovery-{suffix}")];
    let mut tasks = Tasks(Vec::new());
    let limit = if provider.is_some() { 175 } else { 25 };
    let result = AssertUnwindSafe(timeout(
        Duration::from_secs(limit),
        exercise(&pool, &accounts, &actors, &mut tasks, provider),
    ))
    .catch_unwind()
    .await;
    // Abort only listeners/workers owned by this test, then remove exact fixtures.
    for task in &tasks.0 {
        task.abort();
    }
    for task in &mut tasks.0 {
        let _ = task.await;
    }
    query("DELETE FROM human_simulator_actors WHERE actor_id=$1 OR actor_id=$2")
        .bind(&actors[0])
        .bind(&actors[1])
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM cloud_chat_conversations WHERE created_by_account_id=$1 OR created_by_account_id=$2").bind(&accounts[0]).bind(&accounts[1]).execute(&pool).await.unwrap();
    query("DELETE FROM cloud_accounts WHERE account_id=$1 OR account_id=$2")
        .bind(&accounts[0])
        .bind(&accounts[1])
        .execute(&pool)
        .await
        .unwrap();
    match result {
        Ok(result) => result.expect("headless integration completes within its bounded deadline"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn exercise(
    pool: &PgPool,
    accounts: &[String; 2],
    actors: &[String; 2],
    tasks: &mut Tasks,
    live_provider: Option<SystemAgentProviderAuth>,
) {
    let live = live_provider.is_some();
    let human_token = account(pool, &accounts[0]).await;
    let peer_token = account(pool, &accounts[1]).await;
    query("INSERT INTO cloud_contacts(account_id,peer_account_id,created_at) VALUES ($1,$2,$3),($2,$1,$3)")
        .bind(&accounts[0]).bind(&accounts[1]).bind(chrono::Utc::now().to_rfc3339()).execute(pool).await.unwrap();
    let state = Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let app =
        crate::auth::routes::routes(state.clone()).merge(crate::chat_sync::routes::routes(state));
    let kordi = listen(app, tasks).await;
    let client = reqwest::Client::new();
    let created = post_json(&client, format!("{kordi}/v2/chat/conversations"), &human_token,
        &json!({"client_operation_id":Uuid::new_v4(),"kind":"group","shared_title":"Synthetic headless test","client_session_id":format!("sim-session-{}",Uuid::new_v4()),"member_account_ids":[accounts[1]]})).await;
    let conversation: Uuid = created["conversation"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let provider = if let Some(provider) = live_provider {
        provider
    } else {
        let provider_url = listen(
            Router::new()
                .route("/v1/chat/completions", post(model))
                .with_state(observed.clone()),
            tasks,
        )
        .await;
        SystemAgentProviderAuth::openai_api_key(
            "synthetic-provider-token",
            "synthetic-selected-model",
        )
        .unwrap()
        .with_base_url(format!("{provider_url}/v1"))
    };
    let operator_token = "synthetic-operator-token-at-least-32-characters";
    let service = SimulatorService {
        pool: pool.clone(),
        operator_hash: routes::digest(operator_token),
        allowed_accounts: [accounts[0].clone()].into_iter().collect(),
        kordi_api_base: kordi.clone(),
        provider,
        model_slots: Arc::new(Semaphore::new(2)),
    };
    let sim = listen(router(service), tasks).await;
    let mut denied = config("not-allowlisted", &accounts[1], conversation);
    let response = client
        .post(format!("{sim}/v1/sim/actors"))
        .bearer_auth(operator_token)
        .json(&denied)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    let mut actor_config = config(&actors[0], &accounts[0], conversation);
    if live {
        actor_config["objective"] = json!("Send exactly one short friendly greeting to the peer now. Once you observe a message from the peer containing synthetic-peer-reply in conversation history, finish immediately without sending another message. If you already sent a greeting and no peer reply is visible yet, wait briefly. Never finish before observing the peer reply.");
    }
    let registered = post_json(
        &client,
        format!("{sim}/v1/sim/actors"),
        operator_token,
        &actor_config,
    )
    .await;
    let worker_token = registered["worker_token"].as_str().unwrap();
    let denied_status = client
        .get(format!("{sim}/v1/sim/actors/{}/status", actors[0]))
        .bearer_auth("synthetic-wrong-worker-token-at-least-32")
        .send()
        .await
        .unwrap();
    assert_eq!(denied_status.status(), reqwest::StatusCode::UNAUTHORIZED);
    launch(tasks, &sim, &actors[0], worker_token, &human_token);
    wait_sent(pool, &actors[0]).await;
    let rows: Vec<(String,String)> = query_as("SELECT sender_account_id,content::text FROM cloud_chat_messages WHERE conversation_id=$1 ORDER BY conversation_sequence")
        .bind(conversation).fetch_all(pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, accounts[0]);
    let content: Value = serde_json::from_str(&rows[0].1).unwrap();
    assert!(!kordi_human_simulator::protocol::message_text(&content)
        .trim()
        .is_empty());
    if !live {
        assert!(rows[0].1.contains("Synthetic headless question?"));
    }
    post_json(
        &client,
        format!("{kordi}/v2/chat/conversations/{conversation}/messages"),
        &peer_token,
        &message(Uuid::new_v4(), "synthetic-peer-reply"),
    )
    .await;
    wait_finished(pool, &actors[0]).await;
    let row = store::get(pool, &actors[0]).await.unwrap().unwrap();
    assert!(row.model_calls >= 2);
    assert_eq!(row.messages_sent, 1);
    let final_state: ActorState = serde_json::from_value(row.state).unwrap();
    assert!(final_state
        .history
        .iter()
        .any(|item| item.sender == accounts[1] && item.text.contains("synthetic-peer-reply")));
    if live {
        return;
    }
    let requests = observed.lock().unwrap().clone();
    assert!(requests.len() >= 2);
    assert!(requests
        .iter()
        .all(|body| body["model"] == "synthetic-selected-model"
            && body["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains(HUMAN_REQUESTER_SKILL)));
    assert!(requests.last().unwrap()["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("synthetic-peer-reply"));

    // Emulate a process crash after Kordi accepted a send but before confirmation.
    let retry_id = Uuid::new_v4();
    let accepted = post_json(
        &client,
        format!("{kordi}/v2/chat/conversations/{conversation}/messages"),
        &human_token,
        &message(retry_id, "Synthetic recovered question?"),
    )
    .await;
    denied = config(&actors[1], &accounts[0], conversation);
    let recovery = post_json(
        &client,
        format!("{sim}/v1/sim/actors"),
        operator_token,
        &denied,
    )
    .await;
    let recovery_token = recovery["worker_token"].as_str().unwrap();
    let owner = Uuid::new_v4().to_string();
    let leased = store::lease(pool, &actors[1], &owner)
        .await
        .unwrap()
        .unwrap();
    let pending = ActorState {
        pending: Some(PendingSend {
            client_message_id: retry_id,
            text: "Synthetic recovered question?".into(),
        }),
        ..ActorState::default()
    };
    assert!(store::save(
        pool,
        &actors[1],
        &owner,
        leased.generation,
        leased.revision,
        &serde_json::to_value(pending).unwrap()
    )
    .await
    .unwrap());
    assert!(store::release(pool, &actors[1], &owner, leased.generation)
        .await
        .unwrap());
    launch(tasks, &sim, &actors[1], recovery_token, &human_token);
    wait_finished(pool, &actors[1]).await;
    let recovered = store::get(pool, &actors[1]).await.unwrap().unwrap();
    assert_eq!(recovered.messages_sent, 1);
    assert!(recovered.state["pending"].is_null());
    assert_eq!(
        recovered.state["last_delivery"]["client_message_id"],
        retry_id.to_string()
    );
    assert_eq!(
        recovered.state["last_delivery"]["message_id"],
        accepted["message"]["id"]
    );
    let canonical: Vec<(Uuid,)> = query_as("SELECT message_id FROM cloud_chat_messages WHERE sender_account_id=$1 AND client_message_id=$2")
        .bind(&accounts[0]).bind(retry_id).fetch_all(pool).await.unwrap();
    assert_eq!(canonical.len(), 1);
    assert_eq!(
        canonical[0].0.to_string(),
        accepted["message"]["id"].as_str().unwrap()
    );
}
