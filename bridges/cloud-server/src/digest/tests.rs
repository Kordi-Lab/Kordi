use super::{models::*, store};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};

fn input() -> Input {
    Input {
        sources: vec![Source {
            id: "m1".into(),
            conversation_id: "c1".into(),
            session_id: "s1".into(),
            session_title: "Planning".into(),
            sender_account_id: "author".into(),
            sender_name: "Alex".into(),
            text: "Could someone review the draft?".into(),
            created_at: "2026-09-07T09:00:00Z".into(),
            version: 1,
            is_agent: false,
        }],
        calendar_events: vec![],
        existing_tasks: json!([]),
        previous: None,
        locale: "en".into(),
        timezone: "UTC".into(),
        partial: false,
        as_of: "2026-09-07T09:01:00Z".into(),
        viewer_account_id: "viewer".into(),
    }
}
#[test]
fn output_requires_real_evidence_and_preserves_uncertainty() {
    let mut input = input();
    input.sources.push(Source {
        id: "unrelated-message".into(),
        sender_account_id: "unrelated-author".into(),
        ..input.sources[0].clone()
    });
    let mut output = Output {
        claims: vec![Item {
            id: "review".into(),
            title: "A review is needed".into(),
            source_ids: vec!["m1".into()],
            kind: "question".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    assert!(validate_output(&output, &input).is_ok());
    assert!(output.claims[0].owner_account_id.is_none());
    output.claims[0].source_ids = vec!["private".into()];
    assert!(validate_output(&output, &input).is_err());
    output.claims[0].source_ids = vec!["m1".into()];
    output.claims[0].owner_account_id = Some("outsider".into());
    assert!(validate_output(&output, &input).is_err());
    output.claims[0].owner_account_id = Some("unrelated-author".into());
    assert!(validate_output(&output, &input).is_err());
    input.sources[0].is_agent = true;
    output.claims[0].owner_account_id = Some("author".into());
    assert!(validate_output(&output, &input).is_err());
    input.sources[0].is_agent = false;
    output.claims[0].owner_account_id = Some("viewer".into());
    assert!(validate_output(&output, &input).is_ok());
    output.claims.push(output.claims[0].clone());
    assert!(validate_output(&output, &input).is_err());
}
#[test]
fn edited_sources_do_not_carry_old_claims_into_the_next_generation() {
    let saved = input();
    let mut current = saved.sources.clone();
    current[0].version += 1;
    current[0].text = "The earlier request was withdrawn.".into();
    let item = Item {
        id: "review".into(),
        title: "Review requested".into(),
        source_ids: vec!["m1".into()],
        kind: "open".into(),
        ..Default::default()
    };
    let mut previous = Output {
        claims: vec![item.clone()],
        commitments: vec![item],
        ..Default::default()
    };
    let mut unchanged = previous.clone();
    store::retain_previous_evidence(&mut unchanged, &saved.sources, &saved.sources);
    assert_eq!(unchanged.commitments.len(), 1);
    store::retain_previous_evidence(&mut previous, &saved.sources, &current);
    assert!(previous.claims.is_empty());
    assert!(previous.commitments.is_empty());
}

#[test]
fn calendar_validation_rejects_invalid_times() {
    let mut event = CalendarEvent {
        id: "review".into(),
        title: "Review".into(),
        start_at: "2026-09-08T15:00:00Z".into(),
        end_at: Some("2026-09-08T15:30:00Z".into()),
        reminder_at: Some("2026-09-08T14:45:00Z".into()),
        all_day: false,
        source_ids: vec![],
        description: String::new(),
        external_uid: None,
        revision: 0,
    };
    assert!(validate_event(&event).is_ok());
    event.end_at = Some("2026-09-08T14:00:00Z".into());
    assert!(validate_event(&event).is_err());
    event.end_at = None;
    event.reminder_at = Some("2026-09-08T16:00:00Z".into());
    assert!(validate_event(&event).is_err());
}
#[test]
fn control_payloads_are_not_digest_messages() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let raw = URL_SAFE_NO_PAD.encode(json!({"kind":"message","text":"A real message"}).to_string());
    assert_eq!(
        store::visible_text(
            &json!({"blocks":[{"type":"text","text":format!("kordi-cloud-message:{raw}")}]})
        )
        .as_deref(),
        Some("A real message")
    );
    assert!(store::visible_text(
        &json!({"blocks":[{"type":"text","text":"kordi-cloud-agent-cancel:control"}]})
    )
    .is_none());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn postgres_scope_and_atomic_publication() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let viewer = format!("digest-viewer-{suffix}");
    let author = format!("digest-author-{suffix}");
    for account in [&viewer, &author] {
        query("INSERT INTO cloud_accounts(account_id,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES($1,$2,$2,'generated','lorelei',$1,'test',1,$2)")
            .bind(account)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await
            .unwrap();
    }
    store::initialize_preferences(&pool, &viewer, "en-US", "UTC")
        .await
        .unwrap();
    store::initialize_preferences(&pool, &viewer, "fr-FR", "Europe/Paris")
        .await
        .unwrap();
    let preferences: (String, String) =
        query_as("SELECT locale,timezone FROM cloud_account_digests WHERE account_id=$1")
            .bind(&viewer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        preferences,
        ("en-US".into(), "UTC".into()),
        "Opening another device must not overwrite shared generation preferences"
    );
    let public = uuid::Uuid::new_v4();
    let private = uuid::Uuid::new_v4();
    let message = uuid::Uuid::new_v4();
    for conversation in [public, private] {
        query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint) VALUES($1,'group',$2,$3,'test')").bind(conversation).bind(&author).bind(uuid::Uuid::new_v4()).execute(&pool).await.unwrap();
        let id = if conversation == public {
            message
        } else {
            uuid::Uuid::new_v4()
        };
        query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2,1,$3,$4,'test',$5)").bind(id).bind(conversation).bind(&author).bind(uuid::Uuid::new_v4()).bind(json!({"blocks":[{"type":"text","text":"Please review the draft."}]})).execute(&pool).await.unwrap();
    }
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)")
        .bind(public)
        .bind(&viewer)
        .execute(&pool)
        .await
        .unwrap();
    let input = store::input(&pool, &viewer, "en", "UTC", None)
        .await
        .unwrap();
    assert_eq!(input.sources.len(), 1);
    assert_eq!(input.sources[0].id, message.to_string());
    let run = format!("digest_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    query("UPDATE cloud_account_digests SET input_json=$2,active_run_id=$3 WHERE account_id=$1")
        .bind(&viewer)
        .bind(serde_json::to_value(&input).unwrap())
        .bind(&run)
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,claimed_by,lease_expires_at,created_at,updated_at) VALUES($1,$1,$1,'digest:test',$2,$2,'running','test','test-runner',$3,$4,$4)").bind(&run).bind(&viewer).bind((now+chrono::Duration::minutes(5)).to_rfc3339()).bind(now.to_rfc3339()).execute(&pool).await.unwrap();
    let output = Output {
        claims: vec![Item {
            id: "review".into(),
            title: "Review requested".into(),
            source_ids: vec![message.to_string()],
            kind: "question".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    store::complete(
        &pool,
        &run,
        "test-runner",
        &serde_json::to_string(&output).unwrap(),
    )
    .await
    .unwrap();
    let row:(i64,Option<String>,Option<serde_json::Value>)=query_as("SELECT revision,active_run_id,snapshot_input_json FROM cloud_account_digests WHERE account_id=$1").bind(&viewer).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, 1);
    assert!(row.1.is_none());
    assert!(row.2.is_some());
    let count: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_messages WHERE conversation_id=$1")
            .bind(public)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        count.0, 1,
        "No chat message is created by digest completion"
    );
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state='removed' WHERE account_id=$1",
    )
    .bind(&viewer)
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        !store::input_is_currently_authorized(&pool, &viewer, &input)
            .await
            .unwrap()
    );
    let event = CalendarEvent {
        id: "new-event".into(),
        title: "Capacity check".into(),
        start_at: "2026-09-08T15:00:00Z".into(),
        end_at: None,
        reminder_at: None,
        all_day: false,
        source_ids: vec![],
        description: String::new(),
        external_uid: None,
        revision: 0,
    };
    query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) SELECT $1,'capacity-'||i,jsonb_set($2,'{id}',to_jsonb('capacity-'||i)) FROM generate_series(1,1000) i").bind(&viewer).bind(serde_json::to_value(&event).unwrap()).execute(&pool).await.unwrap();
    let state = std::sync::Arc::new(crate::server::ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let session = crate::auth::routes::CloudSession {
        account_id: viewer.clone(),
        token_id: "test".into(),
        device_id: "test".into(),
    };
    let response = super::routes::save_event(
        axum::extract::State(state.clone()),
        axum::Extension(session.clone()),
        axum::extract::Path(event.id.clone()),
        axum::Json(event.clone()),
    )
    .await;
    assert_eq!(
        response.status(),
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "Do not accept events outside the readable calendar capacity"
    );
    let edit = CalendarEvent {
        id: "capacity-1".into(),
        revision: 1,
        ..event
    };
    let response = super::routes::save_event(
        axum::extract::State(state),
        axum::Extension(session),
        axum::extract::Path(edit.id.clone()),
        axum::Json(edit),
    )
    .await;
    assert_eq!(
        response.status(),
        axum::http::StatusCode::OK,
        "A full calendar must still allow edits"
    );
    query("DELETE FROM cloud_chat_conversations WHERE conversation_id=ANY($1)")
        .bind(vec![public, private])
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM cloud_accounts WHERE account_id=ANY($1)")
        .bind(vec![viewer, author])
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
