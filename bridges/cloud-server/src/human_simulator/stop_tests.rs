//! Stop between real Kordi acceptance and worker confirmation, without timing sleeps.
use super::*;
use axum::{
    extract::Request,
    middleware::{self, Next},
    response::Response,
};
use kordi_human_simulator::{client::HttpFailure, protocol::DeliveryReceipt};
use tokio::sync::{oneshot, Notify};

#[derive(Default)]
struct ConfirmationGate {
    arrived: Notify,
    resume: Notify,
}

async fn hold_confirmation(
    State(gate): State<Arc<ConfirmationGate>>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path().ends_with("/confirm") {
        gate.arrived.notify_one();
        gate.resume.notified().await;
    }
    next.run(request).await
}

#[tokio::test]
#[ignore = "requires task-owned PostgreSQL"]
async fn accepted_send_then_stop_reports_indeterminate_without_duplicate_or_new_decision() {
    let url = std::env::var("KORDI_SIM_TEST_DATABASE_URL")
        .expect("explicit isolated simulator test database required");
    assert!(std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET").is_ok());
    let pool = crate::pg::init_pool(&url).await.unwrap();
    store::initialize(&pool).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let accounts = [
        format!("stop-human-{suffix}"),
        format!("stop-peer-{suffix}"),
    ];
    let actor = format!("stop-race-{suffix}");
    let mut tasks = Tasks(Vec::new());
    let outcome = AssertUnwindSafe(timeout(
        Duration::from_secs(20),
        exercise_stop(&pool, &accounts, &actor, &mut tasks),
    ))
    .catch_unwind()
    .await;
    for task in &tasks.0 {
        task.abort();
    }
    for task in &mut tasks.0 {
        let _ = task.await;
    }
    query("DELETE FROM human_simulator_actors WHERE actor_id=$1")
        .bind(&actor)
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM cloud_chat_conversations WHERE created_by_account_id=$1")
        .bind(&accounts[0])
        .execute(&pool)
        .await
        .unwrap();
    for id in &accounts {
        query("DELETE FROM cloud_accounts WHERE account_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    match outcome {
        Ok(result) => result.expect("stop race completes within its deadline"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn exercise_stop(pool: &PgPool, accounts: &[String; 2], actor: &str, tasks: &mut Tasks) {
    let account_token = account(pool, &accounts[0]).await;
    account(pool, &accounts[1]).await;
    query("INSERT INTO cloud_contacts(account_id,peer_account_id,created_at) VALUES ($1,$2,$3),($2,$1,$3)")
        .bind(&accounts[0]).bind(&accounts[1]).bind(chrono::Utc::now().to_rfc3339())
        .execute(pool).await.unwrap();
    let state = Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let kordi = listen(
        crate::auth::routes::routes(state.clone()).merge(crate::chat_sync::routes::routes(state)),
        tasks,
    )
    .await;
    let client = reqwest::Client::new();
    let created = post_json(&client, format!("{kordi}/v2/chat/conversations"), &account_token,
        &json!({"client_operation_id":Uuid::new_v4(),"kind":"group","shared_title":"Synthetic stop race","client_session_id":format!("stop-session-{}",Uuid::new_v4()),"member_account_ids":[accounts[1]]})).await;
    let conversation: Uuid = created["conversation"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let provider_url = listen(
        Router::new()
            .route("/v1/chat/completions", post(model))
            .with_state(observed.clone()),
        tasks,
    )
    .await;
    let provider =
        SystemAgentProviderAuth::openai_api_key("synthetic-provider-token", "synthetic-model")
            .unwrap()
            .with_base_url(format!("{provider_url}/v1"));
    let operator = "synthetic-stop-operator-token-at-least-32";
    let service = SimulatorService {
        pool: pool.clone(),
        operator_hash: routes::digest(operator),
        allowed_accounts: [accounts[0].clone()].into_iter().collect(),
        kordi_api_base: kordi.clone(),
        provider,
        model_slots: Arc::new(Semaphore::new(2)),
    };
    let gate = Arc::new(ConfirmationGate::default());
    let sim = listen(
        router(service).layer(middleware::from_fn_with_state(
            gate.clone(),
            hold_confirmation,
        )),
        tasks,
    )
    .await;
    let registered = post_json(
        &client,
        format!("{sim}/v1/sim/actors"),
        operator,
        &config(actor, &accounts[0], conversation),
    )
    .await;
    let token = registered["worker_token"].as_str().unwrap().to_owned();
    // Seed a persisted decision as if the worker had restarted before dispatch.
    let owner = Uuid::new_v4();
    let lease = store::lease(pool, actor, &owner.to_string())
        .await
        .unwrap()
        .unwrap();
    let client_id = Uuid::new_v4();
    let pending = ActorState {
        pending: Some(PendingSend {
            client_message_id: client_id,
            text: "Synthetic stop-race message".into(),
        }),
        ..ActorState::default()
    };
    assert!(store::save(
        pool,
        actor,
        &owner.to_string(),
        lease.generation,
        lease.revision,
        &serde_json::to_value(&pending).unwrap()
    )
    .await
    .unwrap());
    // Observation checkpoints cannot forge worker delivery receipts.
    let mut forged = pending.clone();
    forged.last_delivery = Some(DeliveryReceipt {
        client_message_id: client_id,
        message_id: Uuid::new_v4(),
    });
    let response = client
        .post(format!("{sim}/v1/sim/actors/{actor}/checkpoint"))
        .bearer_auth(&token)
        .json(&json!({"owner":owner,"generation":lease.generation,
            "revision":lease.revision+1,"state":forged}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    assert!(
        store::release(pool, actor, &owner.to_string(), lease.generation)
            .await
            .unwrap()
    );
    let api = ApiClient::new(&sim, token.clone()).unwrap();
    let worker_actor = actor.to_owned();
    let (done, completed) = oneshot::channel();
    tasks.0.push(tokio::spawn(async move {
        let result = kordi_human_simulator::worker::run_configured(
            api,
            &worker_actor,
            AccountCredentials {
                token: Some(account_token),
                login: None,
            },
        )
        .await;
        let conflict = result
            .err()
            .and_then(|e| e.downcast_ref::<HttpFailure>().map(|e| e.0))
            == Some(reqwest::StatusCode::CONFLICT);
        let _ = done.send(conflict);
    }));
    gate.arrived.notified().await;
    // Entering /confirm proves the real Kordi send already returned an accepted ID.
    let accepted: Vec<(Uuid,)> = query_as("SELECT message_id FROM cloud_chat_messages WHERE conversation_id=$1 AND client_message_id=$2")
        .bind(conversation).bind(client_id).fetch_all(pool).await.unwrap();
    assert_eq!(accepted.len(), 1);
    let stopped = post_json(
        &client,
        format!("{sim}/v1/sim/actors/{actor}/stop"),
        operator,
        &json!({}),
    )
    .await;
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["delivery_status"], "indeterminate");
    assert_eq!(stopped["pending_send"], false);
    assert_eq!(stopped["messages_sent"], 0); // Confirmed count, explicitly not a delivery total.
    gate.resume.notify_one();
    assert!(completed.await.unwrap());
    let row = store::get(pool, actor).await.unwrap().unwrap();
    assert_eq!(row.model_calls, 0);
    assert_eq!(row.messages_sent, 0);
    assert_eq!(
        row.state["pending"]["client_message_id"],
        client_id.to_string()
    );
    assert!(row.state["last_delivery"].is_null());
    let status: Value = client
        .get(format!("{sim}/v1/sim/actors/{actor}/status"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status, stopped);
    let encoded = status.to_string();
    for private in [
        client_id.to_string(),
        accepted[0].0.to_string(),
        accounts[0].clone(),
        "Synthetic stop-race message".into(),
    ] {
        assert!(!encoded.contains(&private));
    }
    // Restarting a terminal actor is a no-op, even though its evidence is retained.
    kordi_human_simulator::worker::run_configured(
        ApiClient::new(&sim, token).unwrap(),
        actor,
        AccountCredentials {
            token: None,
            login: None,
        },
    )
    .await
    .unwrap();
    let count: (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE conversation_id=$1 AND NOT content ? 'group_event'")
            .bind(conversation)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(count.0, 1);
    assert!(observed.lock().unwrap().is_empty());
}
