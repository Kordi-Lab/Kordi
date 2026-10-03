//! Task and artifact activity follows the session's conversation: only its
//! active members record and read it, a direct chat needs a contact as chat
//! messages do, only the recorder changes a row, and rows from someone in a
//! block with the reader are left out.

use super::contact_consent::connect;
use super::*;
use kordi_cloud_server::chat_sync::models::{ConversationKind, CreateConversationRequest};
use kordi_cloud_server::chat_sync::store;
use sqlx_core::query::query;

struct Member {
    token: String,
    id: String,
}

async fn member(router: &axum::Router, prefix: &str) -> Member {
    let (token, id) = signup_account(router, prefix).await;
    Member { token, id }
}

fn task(session_id: &str, task_id: &str, title: &str) -> serde_json::Value {
    json!({"sessionId": session_id, "taskId": task_id, "title": title, "status": "active"})
}

async fn record(
    router: &axum::Router,
    writer: &Member,
    kind: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/session-activity/{kind}"),
            &writer.token,
            body,
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn listed(
    router: &axum::Router,
    reader: &Member,
    session_id: &str,
) -> (StatusCode, Vec<String>) {
    let response = router
        .clone()
        .oneshot(get_with_token(
            &format!(
                "/v1/cloud/session-activity?sessionId={}",
                session_id.replace(':', "%3A")
            ),
            &reader.token,
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = read_json(response).await;
    let mut titles: Vec<String> = ["tasks", "artifacts"]
        .iter()
        .flat_map(|kind| body[*kind].as_array().cloned().unwrap_or_default())
        .map(|row| {
            row["title"]
                .as_str()
                .or(row["name"].as_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    titles.sort();
    (status, titles)
}

fn refused(result: (StatusCode, serde_json::Value), status: StatusCode, code: &str) {
    assert_eq!(result.0, status, "{}", result.1);
    assert_eq!(result.1["errorCode"], code, "{}", result.1);
}

#[tokio::test]
async fn only_members_who_may_write_record_and_read_session_activity() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let writer = member(&router, "activity-writer").await;
    let friend = member(&router, "activity-friend").await;
    let blocker = member(&router, "activity-blocker").await;
    let stranger = member(&router, "activity-stranger").await;
    connect(&router, &writer.token, &friend.token, &friend.id).await;
    connect(&router, &writer.token, &blocker.token, &blocker.id).await;
    let group = format!("session:group:{}", uuid::Uuid::now_v7());
    store::create_conversation(
        &pool,
        &writer.id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Activity".to_string()),
            client_session_id: group.clone(),
            member_account_ids: vec![friend.id.clone(), blocker.id.clone()],
        },
    )
    .await
    .expect("create group");

    // Someone outside the conversation can neither record nor read.
    refused(
        record(
            &router,
            &stranger,
            "tasks",
            task(&group, "plan", "Injected"),
        )
        .await,
        StatusCode::FORBIDDEN,
        "not_a_participant",
    );
    let artifact = json!({"sessionId": group, "artifactId": "notes.md", "name": "Injected file",
                          "path": "notes.md", "kind": "document", "category": "artifact"});
    refused(
        record(&router, &stranger, "artifacts", artifact.clone()).await,
        StatusCode::FORBIDDEN,
        "not_a_participant",
    );
    let (status, _) = record(&router, &writer, "tasks", task(&group, "plan", "Plan")).await;
    assert_eq!(status, StatusCode::OK);
    let mut own_file = artifact.clone();
    own_file["name"] = json!("Notes");
    let (status, _) = record(&router, &writer, "artifacts", own_file).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed(&router, &stranger, &group).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        listed(&router, &friend, &group).await,
        (
            StatusCode::OK,
            vec!["Notes".to_string(), "Plan".to_string()]
        )
    );

    // Another member cannot overwrite a row they did not record.
    refused(
        record(
            &router,
            &friend,
            "tasks",
            task(&group, "plan", "Overwritten"),
        )
        .await,
        StatusCode::CONFLICT,
        "session_activity_conflict",
    );
    refused(
        record(&router, &friend, "artifacts", artifact).await,
        StatusCode::CONFLICT,
        "session_activity_conflict",
    );
    let (status, _) = record(&router, &friend, "tasks", task(&group, "review", "Review")).await;
    assert_eq!(status, StatusCode::OK);

    // A block hides each side's rows from the other, in both directions.
    query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&blocker.id)
    .bind(&writer.id)
    .execute(&pool)
    .await
    .unwrap();
    let (status, _) = record(&router, &blocker, "tasks", task(&group, "own", "Own")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed(&router, &blocker, &group).await,
        (
            StatusCode::OK,
            vec!["Own".to_string(), "Review".to_string()]
        )
    );
    assert_eq!(
        listed(&router, &writer, &group).await,
        (
            StatusCode::OK,
            vec![
                "Notes".to_string(),
                "Plan".to_string(),
                "Review".to_string()
            ]
        )
    );

    // A member who left can no longer record or read.
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left' \
         WHERE account_id = $1 AND conversation_id = (SELECT conversation_id \
           FROM cloud_chat_conversations WHERE legacy_session_id = $2)",
    )
    .bind(&friend.id)
    .bind(&group)
    .execute(&pool)
    .await
    .unwrap();
    refused(
        record(&router, &friend, "tasks", task(&group, "later", "Later")).await,
        StatusCode::FORBIDDEN,
        "not_a_participant",
    );
    assert_eq!(
        listed(&router, &friend, &group).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn a_direct_chat_records_activity_only_between_contacts() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let writer = member(&router, "activity-direct-writer").await;
    let peer = member(&router, "activity-direct-peer").await;
    connect(&router, &writer.token, &peer.token, &peer.id).await;
    let mut ids = [writer.id.clone(), peer.id.clone()];
    ids.sort();
    let direct = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    let (status, _) = record(&router, &writer, "tasks", task(&direct, "plan", "Plan")).await;
    assert_eq!(status, StatusCode::OK);

    query(
        "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
         OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(&writer.id)
    .bind(&peer.id)
    .execute(&pool)
    .await
    .unwrap();
    for account in [&writer, &peer] {
        refused(
            record(&router, account, "tasks", task(&direct, "more", "More")).await,
            StatusCode::FORBIDDEN,
            "CHAT_RELATIONSHIP_REQUIRED",
        );
    }
    // The history stays readable, as the chat's messages do.
    assert_eq!(
        listed(&router, &peer, &direct).await,
        (StatusCode::OK, vec!["Plan".to_string()])
    );
}

#[tokio::test]
async fn a_session_without_a_conversation_shows_only_the_readers_rows() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let reader = member(&router, "activity-loose-reader").await;
    let other = member(&router, "activity-loose-other").await;
    let session = format!("session:self-agent:{}", uuid::Uuid::now_v7());
    refused(
        record(&router, &reader, "tasks", task(&session, "plan", "Plan")).await,
        StatusCode::FORBIDDEN,
        "not_a_participant",
    );
    // Rows recorded before activity required a conversation.
    for (account, task_id) in [(&reader, "mine"), (&other, "theirs")] {
        query(
            "INSERT INTO cloud_session_tasks (task_activity_id, session_id, task_id, title, \
               status, created_by_account_id, participants_json, created_at, updated_at) \
             VALUES ($1, $2, $3, $3, 'active', $4, '[]', now()::text, now()::text)",
        )
        .bind(format!("taskact_{}", uuid::Uuid::new_v4().simple()))
        .bind(&session)
        .bind(task_id)
        .bind(&account.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(
        listed(&router, &reader, &session).await,
        (StatusCode::OK, vec!["mine".to_string()])
    );
    // The account that forked a session into this id sees the copied rows.
    query(
        "INSERT INTO cloud_session_forks (fork_session_id, parent_session_id, \
           created_by_account_id, created_at) VALUES ($1, $2, $3, now()::text)",
    )
    .bind(&session)
    .bind(format!("session:self-agent:{}", uuid::Uuid::now_v7()))
    .bind(&reader.id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        listed(&router, &reader, &session).await,
        (
            StatusCode::OK,
            vec!["mine".to_string(), "theirs".to_string()]
        )
    );
    assert_eq!(
        listed(&router, &other, &session).await,
        (StatusCode::OK, vec!["theirs".to_string()])
    );
}

/// Turning a digest commitment into a task adds it to the source chat's task
/// list, so a direct chat needs a contact for that too.
#[tokio::test]
async fn a_digest_task_joins_a_direct_chat_only_between_contacts() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state.clone()).merge(kordi_cloud_server::digest::routes(state));
    let viewer = member(&router, "activity-digest-viewer").await;
    let peer = member(&router, "activity-digest-peer").await;
    connect(&router, &viewer.token, &peer.token, &peer.id).await;
    let mut ids = [viewer.id.clone(), peer.id.clone()];
    ids.sort();
    let direct = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    let (conversation_id,): (uuid::Uuid,) = sqlx_core::query_as::query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id = $1",
    )
    .bind(&direct)
    .fetch_one(&pool)
    .await
    .unwrap();
    let message = store::send_message(
        &pool,
        &peer.id,
        conversation_id,
        kordi_cloud_server::chat_sync::models::SendMessageRequest {
            client_message_id: uuid::Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": "I will send the draft and the notes."}]}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;
    let source = message.id.to_string();
    let commitment = |id: &str, title: &str| json!({"id": id, "title": title, "sourceIds": [source], "kind": "open"});
    let snapshot = json!({"claims": [], "suggestions": [], "calendarCandidates": [],
                          "commitments": [commitment("draft", "Send the draft"),
                                          commitment("notes", "Send the notes")]});
    let input = json!({
        "sources": [{"id": source, "conversationId": conversation_id.to_string(),
                     "sessionId": direct, "sessionTitle": "Direct", "senderAccountId": peer.id,
                     "senderName": "Peer", "text": "I will send the draft and the notes.",
                     "createdAt": message.created_at, "version": message.version}],
        "calendarEvents": [], "existingTasks": [], "previous": null, "locale": "en",
        "timezone": "UTC", "partial": false, "asOf": chrono::Utc::now().to_rfc3339(),
        "viewerAccountId": viewer.id,
    });
    query(
        "INSERT INTO cloud_account_digests (account_id, snapshot_json, snapshot_input_json) \
         VALUES ($1, $2, $3)",
    )
    .bind(&viewer.id)
    .bind(snapshot)
    .bind(input)
    .execute(&pool)
    .await
    .unwrap();
    let create_task = |item: &str, title: &str| {
        router.clone().oneshot(post_json_with_token(
            &format!("/v1/cloud/digest/items/{item}/task"),
            &viewer.token,
            json!({"title": title, "ownerAccountId": peer.id}),
        ))
    };
    let created = create_task("draft", "Send the draft").await.unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    assert_eq!(
        listed(&router, &peer, &direct).await,
        (StatusCode::OK, vec!["Send the draft".to_string()])
    );

    query(
        "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
         OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(&viewer.id)
    .bind(&peer.id)
    .execute(&pool)
    .await
    .unwrap();
    let refused_task = create_task("notes", "Send the notes").await.unwrap();
    let status = refused_task.status();
    refused(
        (status, read_json(refused_task).await),
        StatusCode::FORBIDDEN,
        "CHAT_RELATIONSHIP_REQUIRED",
    );
    assert_eq!(
        listed(&router, &peer, &direct).await,
        (StatusCode::OK, vec!["Send the draft".to_string()])
    );
}
