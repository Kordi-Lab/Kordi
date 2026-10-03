//! A fork copies the parent's task and artifact activity into the fork id, so
//! a fork may claim only an id that is the forker's own: a new id, or an
//! Agent conversation the forker created and is alone in. Ids worked out from
//! account ids are never fork ids.

use super::contact_consent::connect;
use super::session_activity_access::{listed, member, record, refused, task, Member};
use super::*;
use kordi_cloud_server::chat_sync::models::{ConversationKind, CreateConversationRequest};
use kordi_cloud_server::chat_sync::store;
use sqlx_core::query::query;

async fn agent_chat(
    pool: &sqlx_postgres::PgPool,
    creator: &Member,
    session_id: &str,
    others: &[&Member],
) -> uuid::Uuid {
    store::create_conversation(
        pool,
        &creator.id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: None,
            client_session_id: session_id.to_string(),
            member_account_ids: others.iter().map(|other| other.id.clone()).collect(),
        },
    )
    .await
    .expect("create agent chat")
    .value
    .id
}

async fn fork(
    router: &axum::Router,
    forker: &Member,
    parent: &str,
    fork_session_id: &str,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/sessions/{}/forks", parent.replace(':', "%3A")),
            &forker.token,
            json!({ "forkSessionId": fork_session_id }),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

fn fresh_id() -> String {
    format!("session:fork:{}", uuid::Uuid::new_v4().simple())
}

/// An Agent chat of `owner` holding one task they recorded.
async fn chat_with_task(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &Member,
    title: &str,
) -> String {
    let session = fresh_id();
    agent_chat(pool, owner, &session, &[]).await;
    let (status, body) = record(router, owner, "tasks", task(&session, "plan", title)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    session
}

fn mine(titles: &[&str]) -> (StatusCode, Vec<String>) {
    (
        StatusCode::OK,
        titles.iter().map(ToString::to_string).collect(),
    )
}

#[tokio::test]
async fn a_fork_copies_activity_only_into_an_id_the_forker_owns() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let victim = member(&router, "fork-target-victim").await;
    let stranger = member(&router, "fork-target-stranger").await;
    let former = member(&router, "fork-target-former").await;
    let injected = chat_with_task(&router, &pool, &stranger, "Injected by a stranger").await;

    // The victim's own My Kordi chat, whose id comes from their account id.
    agent_chat(&pool, &victim, "session:self-agent:default", &[]).await;
    let my_kordi = format!("session:self-agent:{}:default", victim.id);
    let (status, _) = record(&router, &victim, "tasks", task(&my_kordi, "own", "Own")).await;
    assert_eq!(status, StatusCode::OK);
    refused(
        fork(&router, &stranger, &injected, &my_kordi).await,
        StatusCode::BAD_REQUEST,
        "invalid_fork",
    );

    // Another Agent chat of the victim's, by its id and by its conversation id.
    let private = fresh_id();
    let private_id = agent_chat(&pool, &victim, &private, &[]).await;
    for target in [private.clone(), private_id.to_string()] {
        refused(
            fork(&router, &stranger, &injected, &target).await,
            StatusCode::CONFLICT,
            "fork_target_in_use",
        );
    }

    // An Agent chat the former contact created with the victim: they are not
    // alone in it, so it is not theirs to fork into after the removal.
    connect(&router, &former.token, &victim.token, &victim.id).await;
    let shared = fresh_id();
    agent_chat(&pool, &former, &shared, &[&victim]).await;
    query(
        "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
         OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(&former.id)
    .bind(&victim.id)
    .execute(&pool)
    .await
    .unwrap();
    let theirs = chat_with_task(&router, &pool, &former, "From a former contact").await;
    refused(
        fork(&router, &former, &theirs, &shared).await,
        StatusCode::CONFLICT,
        "fork_target_in_use",
    );

    // An id without a conversation that holds someone else's activity.
    let loose = fresh_id();
    query(
        "INSERT INTO cloud_session_tasks (task_activity_id, session_id, task_id, title, \
           status, created_by_account_id, participants_json, created_at, updated_at) \
         VALUES ($1, $2, 'loose', 'Loose', 'active', $3, '[]', now()::text, now()::text)",
    )
    .bind(format!("taskact_{}", uuid::Uuid::new_v4().simple()))
    .bind(&loose)
    .bind(&victim.id)
    .execute(&pool)
    .await
    .unwrap();
    refused(
        fork(&router, &stranger, &injected, &loose).await,
        StatusCode::CONFLICT,
        "fork_target_in_use",
    );
    assert_eq!(listed(&router, &stranger, &loose).await, mine(&[]));

    assert_eq!(listed(&router, &victim, &my_kordi).await, mine(&["Own"]));
    assert_eq!(listed(&router, &victim, &private).await, mine(&[]));
    assert_eq!(listed(&router, &victim, &shared).await, mine(&[]));

    // A new id, and an Agent chat the forker is alone in, take the copy.
    let new_fork = fresh_id();
    let (status, body) = fork(&router, &stranger, &injected, &new_fork).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let copied = mine(&["Injected by a stranger"]);
    assert_eq!(listed(&router, &stranger, &new_fork).await, copied);
    refused(
        fork(&router, &stranger, &injected, &new_fork).await,
        StatusCode::CONFLICT,
        "fork_exists",
    );
    let own_chat = fresh_id();
    agent_chat(&pool, &stranger, &own_chat, &[]).await;
    let (status, body) = fork(&router, &stranger, &injected, &own_chat).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(listed(&router, &stranger, &own_chat).await, copied);

    // A fork id that already holds activity keeps only what it holds.
    let busy = fresh_id();
    agent_chat(&pool, &stranger, &busy, &[]).await;
    let (status, _) = record(
        &router,
        &stranger,
        "tasks",
        task(&busy, "busy", "Already here"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = fork(&router, &stranger, &injected, &busy).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        listed(&router, &stranger, &busy).await,
        mine(&["Already here"])
    );
}
