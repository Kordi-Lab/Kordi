//! A group moves and changes hands with its channels, and who pays for runs.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::eligibility::{conversation_org, group, queue_run};
use super::selection::organization_of;
use super::{add, personal_organization, team, ORGS};
use crate::common_ground::tests::db_fixture::{account, app, pool, send, signed_in};

/// A channel of the group whose first conversation has session `space`.
async fn channel(pool: &PgPool, creator: &str, space: &str) -> Uuid {
    let request = crate::chat_sync::models::CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: crate::chat_sync::models::ConversationKind::Group,
        shared_title: Some("Planning".to_string()),
        client_session_id: format!("session:group:{}", Uuid::now_v7()),
        member_account_ids: Vec::new(),
        organization_id: None,
    };
    crate::chat_sync::store::create_group_channel(pool, creator, space, request)
        .await
        .unwrap()
        .value
        .id
}

#[tokio::test]
async fn a_group_moves_and_changes_hands_with_its_channels() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "space_owner").await;
    let priya = account(&pool, "space_member").await;
    let personal = personal_organization(&pool, &alex).await;
    let organization = team(&pool, &alex).await;
    let (first, space) = group(&pool, &personal, &alex, &[&priya]).await;
    let second = channel(&pool, &alex, &space).await;

    let path = format!("{ORGS}/{personal}/transfers");
    let body = json!({"kind": "conversation", "id": second, "targetOrganizationId": organization});
    let (status, answer) = send(&app, "POST", &path, &alex_token, Some(body)).await;
    assert_eq!(status, 200, "{answer}");
    for id in [first, second] {
        assert_eq!(
            conversation_org(&pool, id).await,
            organization,
            "the whole group moves"
        );
    }

    let owner = format!("/v2/chat/conversations/{first}/owner");
    let body = json!({"client_operation_id": Uuid::now_v7(), "account_id": priya});
    let (status, answer) = send(&app, "PUT", &owner, &alex_token, Some(body)).await;
    assert_eq!(status, 200, "{answer}");
    for id in [first, second] {
        let (owner,): (String,) = query_as("SELECT cloud_conversation_owner($1)")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(owner, priya, "every channel changes hands");
    }

    // A direct chat stays with its people.
    let direct = Uuid::now_v7();
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
          client_operation_id, creation_fingerprint, legacy_session_id) \
         VALUES ($1, 'direct', $2, $3, 'fixture', $4)",
    )
    .bind(direct)
    .bind(&alex)
    .bind(Uuid::now_v7())
    .bind(format!("session:direct-person:{alex}:{priya}"))
    .execute(&pool)
    .await
    .unwrap();
    let body = json!({"kind": "conversation", "id": direct, "targetOrganizationId": organization});
    let (status, answer) = send(&app, "POST", &path, &alex_token, Some(body)).await;
    assert_eq!(
        (status, answer["errorCode"].as_str()),
        (409, Some("direct_conversation"))
    );
}

async fn named_run(
    pool: &PgPool,
    session: &str,
    owner: &str,
    requester: &str,
    named: &str,
) -> String {
    let run_id = format!("run_named_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
          session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
          updated_at, organization_id) \
         VALUES ($1, $1, $1, $2, $3, $4, 'queued', '{}', now()::text, now()::text, $5)",
    )
    .bind(&run_id)
    .bind(session)
    .bind(owner)
    .bind(requester)
    .bind(named)
    .execute(pool)
    .await
    .unwrap();
    run_id
}

#[tokio::test]
async fn a_team_pays_only_for_work_its_members_own_or_request() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "pay_owner").await;
    let service = account(&pool, "pay_service").await;
    let sam = account(&pool, "pay_outsider").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &sam, "member").await;
    let runs = "cloud_agent_fallback_runs";
    let service_home = personal_organization(&pool, &service).await;
    let sam_home = personal_organization(&pool, &sam).await;

    // A server-run agent's work outside any conversation, named for a team:
    // kept while its requester is a member.
    let grounding = format!("common-ground:{sam}");
    let kept = named_run(&pool, &grounding, &service, &sam, &organization).await;
    assert_eq!(
        organization_of(&pool, runs, "run_id", &kept).await,
        organization
    );
    let stranger = account(&pool, "pay_stranger").await;
    let refused = named_run(&pool, &grounding, &service, &stranger, &organization).await;
    assert_eq!(
        organization_of(&pool, runs, "run_id", &refused).await,
        service_home
    );

    // A named personal organization must belong to the owner or requester.
    let foreign = named_run(&pool, &grounding, &service, &stranger, &sam_home).await;
    assert_eq!(
        organization_of(&pool, runs, "run_id", &foreign).await,
        service_home
    );

    // A run admitted against a pool keeps the organization it was admitted
    // against, even after its requester leaves.
    let reserved = format!("run_named_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_resource_pool_reservations \
             (run_id, pool_id, usage_day, feature, scope_id, organization_id) \
         VALUES ($1, 'example', CURRENT_DATE, 'grounding', $2, $3)",
    )
    .bind(&reserved)
    .bind(&sam)
    .bind(&organization)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
          session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
          updated_at, organization_id) \
         VALUES ($1, $1, $1, $2, $3, $4, 'queued', '{}', now()::text, now()::text, $5)",
    )
    .bind(&reserved)
    .bind(&grounding)
    .bind(&service)
    .bind(&sam)
    .bind(&organization)
    .execute(&pool)
    .await
    .unwrap();
    let path = format!("{ORGS}/{organization}/members/{sam}");
    assert_eq!(send(&app, "DELETE", &path, &alex_token, None).await.0, 204);
    query("UPDATE cloud_agent_fallback_runs SET status = 'leased' WHERE run_id = ANY($1)")
        .bind(vec![reserved.clone(), kept.clone()])
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        organization_of(&pool, runs, "run_id", &reserved).await,
        organization
    );
    assert_eq!(
        organization_of(&pool, runs, "run_id", &kept).await,
        service_home,
        "without a reservation the start check applies"
    );

    // In a team conversation, a server-run agent the writer named for it is
    // charged to the team; an outsider's own agent is not.
    let (_, session) = group(&pool, &organization, &alex, &[&sam]).await;
    let pass = named_run(&pool, &session, &service, &alex, &organization).await;
    assert_eq!(
        organization_of(&pool, runs, "run_id", &pass).await,
        organization
    );
    let outsider = queue_run(&pool, &session, &sam).await;
    assert_eq!(
        organization_of(&pool, runs, "run_id", &outsider).await,
        sam_home
    );
}
