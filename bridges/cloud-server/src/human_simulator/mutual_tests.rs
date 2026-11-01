//! Two independent live-model actors talk through canonical Kordi HTTP APIs.
use super::*;
use kordi_human_simulator::protocol::message_text;
use std::collections::HashSet;
use std::time::Instant;

#[tokio::test]
#[ignore = "requires task-owned PostgreSQL and explicit live provider opt-in"]
async fn live_two_simulators_exchange_messages() {
    assert_eq!(
        std::env::var("KORDI_SIM_LIVE_MODEL_TEST").as_deref(),
        Ok("1"),
        "explicit live model opt-in required"
    );
    let provider = PendingSystemAgentConfig::from_env()
        .ok()
        .flatten()
        .expect("live System provider configuration required")
        .provider_auth;
    let url = std::env::var("KORDI_SIM_TEST_DATABASE_URL")
        .expect("explicit task-owned database required");
    assert!(std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET").is_ok());
    let pool = crate::pg::init_pool(&url).await.unwrap();
    store::initialize(&pool).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let accounts = [format!("sim-alice-{suffix}"), format!("sim-bob-{suffix}")];
    let actors = [format!("alice-{suffix}"), format!("bob-{suffix}")];
    let mut tasks = Tasks(Vec::new());
    let started = Instant::now();
    let result = AssertUnwindSafe(timeout(
        Duration::from_secs(180),
        exchange(&pool, &accounts, &actors, provider, &mut tasks),
    ))
    .catch_unwind()
    .await;
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
    query("DELETE FROM cloud_chat_conversations WHERE created_by_account_id=$1 OR created_by_account_id=$2")
        .bind(&accounts[0]).bind(&accounts[1]).execute(&pool).await.unwrap();
    query("DELETE FROM cloud_accounts WHERE account_id=$1 OR account_id=$2")
        .bind(&accounts[0])
        .bind(&accounts[1])
        .execute(&pool)
        .await
        .unwrap();
    let mut report = match result {
        Ok(result) => result.expect("two live simulators complete within 180 seconds"),
        Err(panic) => std::panic::resume_unwind(panic),
    };
    report["elapsed_seconds"] = json!(started.elapsed().as_secs_f64());
    report["fixtures_cleaned"] = json!(true);
    if let Ok(path) = std::env::var("KORDI_SIM_TEST_REPORT") {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(path)
            .expect("create new sanitized synthetic report")
            .write_all(&serde_json::to_vec_pretty(&report).unwrap())
            .unwrap();
    }
    println!("Two live simulators exchanged four messages; both received all four canonical messages. No App was used.");
}

async fn exchange(
    pool: &PgPool,
    accounts: &[String; 2],
    actors: &[String; 2],
    provider: SystemAgentProviderAuth,
    tasks: &mut Tasks,
) -> Value {
    let tokens = [
        account(pool, &accounts[0]).await,
        account(pool, &accounts[1]).await,
    ];
    for (index, name) in ["Alice (simulator)", "Bob (simulator)"].iter().enumerate() {
        query("UPDATE cloud_accounts SET display_name=$2 WHERE account_id=$1")
            .bind(&accounts[index])
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }
    query("INSERT INTO cloud_contacts(account_id,peer_account_id,created_at) VALUES ($1,$2,$3),($2,$1,$3)")
        .bind(&accounts[0]).bind(&accounts[1]).bind(chrono::Utc::now().to_rfc3339()).execute(pool).await.unwrap();
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
    let created = post_json(&client,format!("{kordi}/v2/chat/conversations"),&tokens[0],
        &json!({"client_operation_id":Uuid::new_v4(),"kind":"group","shared_title":"Synthetic Alice and Bob scheduling test","client_session_id":format!("mutual-{}",Uuid::new_v4()),"member_account_ids":[accounts[1]]})).await;
    let conversation: Uuid = created["conversation"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let operator = "synthetic-mutual-operator-at-least-32-characters";
    let service = SimulatorService {
        pool: pool.clone(),
        operator_hash: routes::digest(operator),
        allowed_accounts: accounts.iter().cloned().collect(),
        kordi_api_base: kordi,
        provider,
        model_slots: Arc::new(Semaphore::new(2)),
    };
    let sim = listen(router(service), tasks).await;
    let objectives = [
        "You are Alice in a synthetic scheduling conversation with Bob. Send exactly two brief English messages. First, ask Bob to choose 15:00 UTC or 16:00 UTC for a 15-minute meeting. Wait until Bob answers. Second, confirm the time Bob selected, using the literal time format 16:00 UTC when that is his choice. After your second message, wait until Bob acknowledges, then finish without another message. Do not finish before receiving his acknowledgement. Do not repeat a message. Count your own messages by actor_account_id in history.",
        "You are Bob in a synthetic scheduling conversation with Alice. Send exactly two brief English messages. Wait until Alice proposes a meeting time. First, tell her you are available only at 16:00 UTC, using that exact time format. Wait until Alice confirms. Second, acknowledge her confirmation. After your second message, finish or wait without sending again. Do not finish before sending both messages. Do not repeat a message. Count your own messages by actor_account_id in history."
    ];
    let outcomes = Arc::new(Mutex::new([None, None]));
    for i in 0..2 {
        let mut config = config(&actors[i], &accounts[i], conversation);
        config["objective"] = json!(objectives[i]);
        config["persona"] = json!(if i == 0 {
            "Alice: friendly, concise organizer."
        } else {
            "Bob: friendly, concise participant."
        });
        config["private_facts"] = json!(if i == 0 {
            vec!["Either proposed time works for Alice."]
        } else {
            vec!["Only 16:00 UTC works for Bob."]
        });
        config["max_model_calls"] = json!(8);
        config["max_messages"] = json!(3);
        config["max_wait_seconds"] = json!(3);
        let registered =
            post_json(&client, format!("{sim}/v1/sim/actors"), operator, &config).await;
        let api =
            ApiClient::new(&sim, registered["worker_token"].as_str().unwrap().into()).unwrap();
        let credentials = AccountCredentials {
            token: Some(tokens[i].clone()),
            login: None,
        };
        let actor = actors[i].clone();
        let outcomes = outcomes.clone();
        tasks.0.push(tokio::spawn(async move {
            let result =
                kordi_human_simulator::worker::run_configured(api, &actor, credentials).await;
            outcomes.lock().unwrap()[i] = Some(result.is_ok());
        }));
    }
    let rows = loop {
        assert!(
            !outcomes.lock().unwrap().contains(&Some(false)),
            "simulator worker exited unexpectedly"
        );
        let rows:Vec<(Uuid,Uuid,String,String,i64)>=query_as("SELECT message_id,client_message_id,sender_account_id,content::text,conversation_sequence FROM cloud_chat_messages WHERE conversation_id=$1 ORDER BY conversation_sequence")
            .bind(conversation).fetch_all(pool).await.unwrap();
        assert!(
            rows.len() <= 4,
            "actors exceeded the four-message test protocol"
        );
        let mut received = true;
        for actor in actors {
            let row = store::get(pool, actor).await.unwrap().unwrap();
            assert_ne!(
                row.state["status"], "stopped",
                "simulator hit a failure or budget limit"
            );
            let state: ActorState = serde_json::from_value(row.state).unwrap();
            received &= rows.len() == 4
                && row.messages_sent == 2
                && rows
                    .iter()
                    .all(|message| state.history.iter().any(|seen| seen.id == message.0));
        }
        if received {
            break rows;
        }
        sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(
        rows.iter().map(|row| &row.2).collect::<Vec<_>>(),
        vec![&accounts[0], &accounts[1], &accounts[0], &accounts[1]],
        "actors must alternate their two turns"
    );
    assert_eq!(
        rows.iter().map(|row| row.0).collect::<HashSet<_>>().len(),
        4
    );
    assert_eq!(
        rows.iter().map(|row| row.1).collect::<HashSet<_>>().len(),
        4
    );
    assert!(rows.windows(2).all(|pair| pair[0].4 < pair[1].4));
    let mut transcript = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let mut text = message_text(&serde_json::from_str(&row.3).unwrap());
        assert!(!text.trim().is_empty());
        if index == 1 || index == 2 {
            assert!(
                text.contains("16:00 UTC"),
                "reply and confirmation must agree on Bob's available time"
            );
        }
        for i in 0..2 {
            text = text
                .replace(&accounts[i], if i == 0 { "Alice" } else { "Bob" })
                .replace(&actors[i], if i == 0 { "Alice" } else { "Bob" });
        }
        text = text.replace(&conversation.to_string(), "[synthetic conversation]");
        transcript.push(
            json!({"turn":index+1,"sender":if row.2==accounts[0]{"Alice"}else{"Bob"},"text":text}),
        );
    }
    let mut counts = Vec::new();
    for (i, actor) in actors.iter().enumerate() {
        post_json(
            &client,
            format!("{sim}/v1/sim/actors/{actor}/stop"),
            operator,
            &json!({}),
        )
        .await;
        let row = store::get(pool, actor).await.unwrap().unwrap();
        assert_eq!(row.state["status"], "stopped");
        assert!(row.owner.is_none());
        counts.push(json!({"actor":if i==0{"Alice"}else{"Bob"},"messages_sent":row.messages_sent,"model_calls":row.model_calls,"messages_observed":4,"status":"stopped"}));
    }
    json!({"test":"live_two_simulators_exchange_messages","synthetic":true,"environment":"isolated loopback Kordi HTTP and PostgreSQL","model":"existing authorized System model","app_required":false,"message_count":4,"duplicate_messages":0,"actors":counts,"transcript":transcript})
}
