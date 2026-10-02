//! PiP joining a group against a real database: members' devices hear about
//! it, PiP starts reading at the newest message, and the member lists clients
//! send never remove PiP.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use crate::chat_sync::models::{AddConversationMembersRequest, SendMessageRequest};
use crate::plan_cards::tests::{seed_account, seed_conversation};

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn pip_joins_at_the_newest_message_and_client_member_lists_keep_it() {
    let _settings = super::GROUP_SETTING_TESTS.read().await;
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    let pip = super::test_service_account();
    query("INSERT INTO cloud_accounts(account_id,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,avatar_url) VALUES($1,$2,$2,'generated','lorelei',$1,'test',1,$2,$3) ON CONFLICT (account_id) DO NOTHING")
        .bind(pip)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(crate::avatars::generated_avatar_marker("lorelei", pip, 1))
        .execute(&pool)
        .await
        .unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let (jordan, maya) = (format!("jordan-{suffix}"), format!("maya-{suffix}"));
    for account in [&jordan, &maya] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &jordan, &[&jordan, &maya]).await;
    query("UPDATE cloud_chat_conversation_members SET role = 'owner' WHERE conversation_id = $1 AND account_id = $2")
        .bind(chat)
        .bind(&jordan)
        .execute(&pool)
        .await
        .unwrap();
    for text in ["Dinner Friday?", "Sure, 7pm works"] {
        let request = SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        };
        crate::chat_sync::store::send_message(&pool, &jordan, chat, request)
            .await
            .expect("send message");
    }

    assert!(
        !super::membership::join_conversation(&pool, pip, chat)
            .await
            .unwrap(),
        "PiP never joins a group whose setting does not turn it on"
    );
    set_pip_setting(&pool, chat, true).await;
    assert!(super::membership::join_conversation(&pool, pip, chat)
        .await
        .unwrap());
    assert!(
        !super::membership::join_conversation(&pool, pip, chat)
            .await
            .unwrap(),
        "joining again changes nothing"
    );
    let (seen, context_start, latest): (i64, i64, i64) = query_as(
        "SELECT state.seen_sequence, state.context_start_sequence, conversation.latest_message_sequence
         FROM cloud_pip_conversation_state state
         JOIN cloud_chat_conversations conversation USING (conversation_id)
         WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(latest >= 2);
    assert_eq!(seen, latest, "history from before PiP joined is not new");
    assert_eq!(
        context_start, latest,
        "history from before PiP joined is never provider context"
    );
    let notified: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_user_sync_events
         WHERE conversation_id = $1 AND event_type = 'membership.updated'
         ORDER BY account_id",
    )
    .bind(chat)
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected = vec![jordan.clone(), maya.clone()];
    expected.sort();
    assert_eq!(
        notified.into_iter().map(|row| row.0).collect::<Vec<_>>(),
        expected
    );

    // The owner's client sends the group as it shows it: without PiP.
    let conversation = crate::chat_sync::store::add_conversation_members(
        &pool,
        &jordan,
        chat,
        AddConversationMembersRequest {
            client_operation_id: Uuid::new_v4(),
            member_account_ids: vec![maya.clone()],
            replace: true,
        },
    )
    .await
    .expect("replace members");
    assert!(conversation
        .members
        .iter()
        .any(|member| member.account_id == pip && member.membership_state == "active"));
}

async fn isolated_pool() -> sqlx_postgres::PgPool {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    pool
}

async fn send_text(pool: &sqlx_postgres::PgPool, sender: &str, chat: Uuid, text: &str) {
    crate::chat_sync::store::send_message(
        pool,
        sender,
        chat,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send message");
}

async fn pip_active(pool: &sqlx_postgres::PgPool, chat: Uuid, pip: &str) -> bool {
    let (active,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active')",
    )
    .bind(chat)
    .bind(pip)
    .fetch_one(pool)
    .await
    .unwrap();
    active
}

async fn set_pip_setting(pool: &sqlx_postgres::PgPool, chat: Uuid, enabled: bool) {
    query(
        "INSERT INTO cloud_chat_ai_policies (conversation_id, pip_enabled) VALUES ($1, $2)
         ON CONFLICT (conversation_id) DO UPDATE SET pip_enabled = EXCLUDED.pip_enabled",
    )
    .bind(chat)
    .bind(enabled)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn startup_reconciles_pip_membership_with_each_group_setting() {
    // Reconciliation reads every group, so no other test may change one
    // of its group settings meanwhile.
    let _settings = super::GROUP_SETTING_TESTS.write().await;
    let pool = isolated_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    // A PiP account of this test's own, so other tests' groups are unaffected.
    let pip = format!("pip-reconcile-{suffix}");
    let member = format!("member-reconcile-{suffix}");
    for account in [&pip, &member] {
        seed_account(&pool, account).await;
    }
    let [kept, without_row, enable, disable] = [(); 4].map(|_| Uuid::new_v4());
    seed_conversation(&pool, kept, &member, &[&member, &pip]).await;
    seed_conversation(&pool, without_row, &member, &[&member]).await;
    seed_conversation(&pool, enable, &member, &[&member]).await;
    seed_conversation(&pool, disable, &member, &[&member, &pip]).await;
    set_pip_setting(&pool, enable, true).await;
    set_pip_setting(&pool, disable, false).await;
    send_text(&pool, &member, enable, "Dinner Friday?").await;

    super::membership::reconcile_groups(&pool, &pip)
        .await
        .expect("reconcile");

    // Groups from before the setting keep PiP exactly as they have it: the
    // recorded setting matches membership. (A concurrent test that starts the
    // real PiP may record `kept` first, as off for that account; the setting
    // and the membership still agree.)
    for (chat, expected) in [(kept, None), (without_row, Some(false))] {
        let (enabled,): (bool,) =
            query_as("SELECT pip_enabled FROM cloud_chat_ai_policies WHERE conversation_id = $1")
                .bind(chat)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pip_active(&pool, chat, &pip).await, enabled);
        if let Some(expected) = expected {
            assert_eq!(enabled, expected, "grandfathered setting");
        }
    }
    assert!(pip_active(&pool, enable, &pip).await, "joined where on");
    assert!(!pip_active(&pool, disable, &pip).await, "left where off");
    let left: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_user_sync_events
         WHERE conversation_id = $1 AND event_type = 'membership.updated'",
    )
    .bind(disable)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(left, vec![(member.clone(),)], "members hear that PiP left");
    let again = super::membership::reconcile_groups(&pool, &pip)
        .await
        .expect("reconcile again");
    assert_eq!(
        (again.joined, again.left),
        (0, 0),
        "a second pass is a no-op"
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn rejoining_pip_starts_reading_at_the_newest_message() {
    let _settings = super::GROUP_SETTING_TESTS.read().await;
    let pool = isolated_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let pip = format!("pip-rejoin-{suffix}");
    let member = format!("member-rejoin-{suffix}");
    for account in [&pip, &member] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &member, &[&member]).await;
    send_text(&pool, &member, chat, "Before PiP").await;
    set_pip_setting(&pool, chat, true).await;
    assert!(super::membership::join_conversation(&pool, &pip, chat)
        .await
        .unwrap());
    set_pip_setting(&pool, chat, false).await;
    assert!(
        crate::chat_sync::store::leave_service_member_now(&pool, chat, &pip)
            .await
            .unwrap()
    );
    send_text(&pool, &member, chat, "While PiP was off").await;
    // A join that arrives after the group turned PiP off (a retried or late
    // request) changes nothing.
    assert!(!super::membership::join_conversation(&pool, &pip, chat)
        .await
        .unwrap());
    assert!(!pip_active(&pool, chat, &pip).await);
    send_text(&pool, &member, chat, "Still off").await;
    // Old enough that the sweep's two-minute rule would pick them up.
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '10 minutes' WHERE conversation_id = $1")
        .bind(chat)
        .execute(&pool)
        .await
        .unwrap();
    set_pip_setting(&pool, chat, true).await;
    // The step that commits the membership already moved PiP's reading
    // position, so a sweep right after it finds nothing from while PiP was off.
    assert!(crate::chat_sync::store::join_service_member(
        &pool,
        chat,
        &pip,
        super::membership::PIP_CONVERSATION_KINDS
    )
    .await
    .unwrap());
    let swept: Vec<(Uuid, Option<String>, i64, i64, i64, serde_json::Value)> =
        query_as(super::store::SWEEP_SQL)
            .bind(&pip)
            .bind(1000_i64)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(swept.iter().all(|row| row.0 != chat), "{swept:?}");
    let (seen, context_start, latest): (i64, i64, i64) = query_as(
        "SELECT state.seen_sequence, state.context_start_sequence, conversation.latest_message_sequence
         FROM cloud_pip_conversation_state state
         JOIN cloud_chat_conversations conversation USING (conversation_id)
         WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((seen, context_start), (latest, latest));
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn cards_refresh_in_place_but_post_nothing_new_while_pip_is_off() {
    use crate::plan_cards::models::{PlanCardOption, PlanCardRow, PlanCardState};
    let pool = isolated_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let pip = format!("pip-cards-{suffix}");
    let member = format!("member-cards-{suffix}");
    for account in [&pip, &member] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &member, &[&member, &pip]).await;
    let mut row = PlanCardRow {
        event_id: format!("plan_{suffix}"),
        conversation_id: chat.to_string(),
        revision: 1,
        state: PlanCardState::AwaitingConfirmation,
        title: "Dinner".to_string(),
        start_at: None,
        end_at: None,
        location: None,
        unresolved_fields: Vec::new(),
        source_message_ids: Vec::new(),
        participants: Vec::new(),
        manager_ids: Vec::new(),
        options: Vec::new(),
        note: None,
    };
    assert!(super::cards::sync_card_messages(&pool, &pip, &row)
        .await
        .unwrap()
        .is_some());
    crate::chat_sync::store::leave_service_member_now(&pool, chat, &pip)
        .await
        .unwrap();
    // A poll now needs a vote card no message shows yet.
    row.revision = 2;
    row.state = PlanCardState::Polling;
    row.options = vec![PlanCardOption {
        id: "a".to_string(),
        label: "Friday".to_string(),
        start_at: None,
        end_at: None,
        location: None,
        votes: Vec::new(),
    }];
    assert_eq!(
        super::cards::sync_card_messages(&pool, &pip, &row)
            .await
            .unwrap(),
        None
    );
    let carriers: Vec<(serde_json::Value,)> =
        query_as("SELECT content FROM cloud_chat_messages WHERE conversation_id = $1")
            .bind(chat)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(carriers.len(), 1, "no new card message while PiP is off");
    assert_eq!(
        carriers[0].0["blocks"][0]["revision"], 2,
        "the card refreshed"
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn pip_input_leaves_out_opted_out_members() {
    let _settings = super::GROUP_SETTING_TESTS.read().await;
    let pool = isolated_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let pip = format!("pip-input-{suffix}");
    let (open, quiet) = (format!("open-{suffix}"), format!("quiet-{suffix}"));
    for account in [&pip, &open, &quiet] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &open, &[&open, &quiet]).await;
    set_pip_setting(&pool, chat, true).await;
    assert!(super::membership::join_conversation(&pool, &pip, chat)
        .await
        .unwrap());
    query("INSERT INTO cloud_chat_ai_opt_outs (conversation_id, account_id) VALUES ($1, $2)")
        .bind(chat)
        .bind(&quiet)
        .execute(&pool)
        .await
        .unwrap();
    send_text(&pool, &open, chat, "Count me in for Saturday").await;
    send_text(&pool, &quiet, chat, "I can't make Saturday").await;
    // A reply the quiet member's agent wrote is not covered by the setting.
    let envelope = json!({"kind": "group-message", "message": {
        "id": format!("agent-{suffix}"), "senderAccountId": quiet, "senderKind": "agent",
        "senderAgentId": format!("cloud-agent:{quiet}"), "text": "Agent note: Saturday is open"}});
    send_text(
        &pool,
        &quiet,
        chat,
        &format!(
            "kordi-cloud-group:{}",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                envelope.to_string()
            )
        ),
    )
    .await;
    let (start, latest): (i64, i64) = query_as(
        "SELECT state.context_start_sequence, conversation.latest_message_sequence
         FROM cloud_pip_conversation_state state
         JOIN cloud_chat_conversations conversation USING (conversation_id)
         WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    let config = super::PipConfig {
        account_id: pip.clone(),
        owner_email: "pip-input@example.test".to_string(),
        agent_id: "pip-input-test".to_string(),
        name: "PiP".to_string(),
        subtitle: "Test".to_string(),
        provider_auth: super::PipProviderAuth::openai_api_key("synthetic-key", "synthetic-model")
            .unwrap(),
    };
    let input = super::input::build_input(
        &pool,
        &config,
        &super::input::Candidate {
            conversation_id: chat,
            legacy_session_id: String::new(),
            latest_sequence: latest,
            seen_sequence: start,
            context_start_sequence: start,
            hooks_fired: json!({}),
        },
    )
    .await
    .unwrap();
    let texts = input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["text"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "Count me in for Saturday".to_string(),
            "Agent note: Saturday is open".to_string()
        ]
    );
    for message in input["messages"].as_array().unwrap() {
        // The quiet member appears only through their agent's reply, which
        // never lets PiP suggest an answer for them.
        let from_quiet = message["senderId"] == json!(quiet);
        assert_eq!(message["fromAgent"], json!(from_quiet), "{message}");
    }
}
