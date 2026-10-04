//! Migration 110 converts one-way contact rows. Only a peer's own consent
//! completes a pair; everything else becomes (or stays) a request, and every
//! change is archived so an operator can revert it.

use super::*;

const T0: &str = "2026-01-01T00:00:00Z";

async fn add_account(pool: &PgPool, account_id: &str) {
    query(
        "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) \
         VALUES($1,$1,$2,$2,'generated','lorelei',$1,'fixture',1,$2)",
    )
    .bind(account_id)
    .bind(T0)
    .execute(pool)
    .await
    .unwrap();
}

async fn add_contact(pool: &PgPool, account_id: &str, peer_account_id: &str, created_at: &str) {
    query("INSERT INTO cloud_contacts(account_id,peer_account_id,created_at) VALUES($1,$2,$3)")
        .bind(account_id)
        .bind(peer_account_id)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
}

async fn add_request(pool: &PgPool, request_id: &str, from: &str, to: &str, status: &str) {
    query("INSERT INTO cloud_contact_requests(request_id,from_account_id,to_account_id,status,created_at,decided_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $4='pending' THEN NULL ELSE $5 END)")
        .bind(request_id)
        .bind(from)
        .bind(to)
        .bind(status)
        .bind(T0)
        .execute(pool)
        .await
        .unwrap();
}

async fn add_system_agent(pool: &PgPool, owner: &str) {
    query("INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,status,name,role,system_prompt,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,is_system_managed) VALUES($1,$2,'active','Service','support','fixture',$3,$3,'generated','thumbs',$1,'fixture',1,$3,TRUE)")
        .bind(format!("agent-{owner}"))
        .bind(owner)
        .bind(T0)
        .execute(pool)
        .await
        .unwrap();
}

/// A direct conversation between two accounts with one message per
/// `(sender, kind, text, deleted)` entry.
async fn add_direct_chat(
    pool: &PgPool,
    session: &str,
    members: [&str; 2],
    messages: &[(&str, &str, &str, bool)],
) {
    let conversation = Uuid::new_v4();
    let next = messages.len() as i64 + 1;
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id,next_message_sequence,latest_message_sequence) VALUES($1,'direct',$2,$3,'fixture',$4,$5,$6)")
        .bind(conversation).bind(members[0]).bind(Uuid::new_v4()).bind(session).bind(next).bind(next - 1)
        .execute(pool).await.unwrap();
    for member in members {
        query(
            "INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)",
        )
        .bind(conversation)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    }
    for (index, (sender, kind, text, deleted)) in messages.iter().enumerate() {
        query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,message_kind,content,deleted_at) VALUES($1,$2,$3,$4,$5,'fixture',$6,$7,CASE WHEN $8 THEN now() END)")
            .bind(Uuid::new_v4()).bind(conversation).bind(index as i64 + 1).bind(sender).bind(Uuid::new_v4()).bind(kind)
            .bind(json!({"schema":1,"blocks":[{"type":"text","text":text}]})).bind(deleted)
            .execute(pool).await.unwrap();
    }
}

async fn contacts(pool: &PgPool) -> Vec<(String, String, String)> {
    query_as("SELECT account_id,peer_account_id,created_at FROM cloud_contacts ORDER BY 1,2")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn requests(pool: &PgPool) -> Vec<(String, String, String, Option<String>)> {
    query_as("SELECT from_account_id,to_account_id,status,message FROM cloud_contact_requests ORDER BY 1,2,3,created_at")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn outcomes(pool: &PgPool) -> Vec<(String, String, String)> {
    query_as("SELECT account_id,peer_account_id,outcome FROM cloud_contact_consent_backfill WHERE reverted_at IS NULL ORDER BY 1,2")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn chat_counts(pool: &PgPool) -> (i64, i64, i64) {
    query_as("SELECT (SELECT count(*) FROM cloud_chat_conversations),(SELECT count(*) FROM cloud_chat_messages),(SELECT count(*) FROM cloud_chat_conversation_members)")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn convert(pool: &PgPool) -> i32 {
    query_as::<_, (i32,)>("SELECT cloud_convert_one_way_contacts()")
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

fn row(account: &str, peer: &str, outcome: &str) -> (String, String, String) {
    (account.into(), peer.into(), outcome.into())
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_109_converts_one_way_contacts_only_with_peer_consent() {
    // 109 is the last version before contact consent (110).
    let pool = fixture(109).await;
    for account in [
        "mutual-a",
        "mutual-b",
        "wrote-a",
        "wrote-b",
        "agentdm-a",
        "agentdm-b",
        "assist-a",
        "assist-b",
        "pending-a",
        "pending-b",
        "declined-a",
        "declined-b",
        "reverse-a",
        "reverse-b",
        "accepted-a",
        "accepted-b",
        "user",
        "pip-like",
        "support-like",
        "self",
    ] {
        add_account(&pool, account).await;
    }
    add_system_agent(&pool, "pip-like").await;
    add_system_agent(&pool, "support-like").await;
    add_contact(&pool, "mutual-a", "mutual-b", T0).await;
    add_contact(&pool, "mutual-b", "mutual-a", T0).await;
    // The peer wrote in their person DM: consent.
    add_contact(&pool, "wrote-a", "wrote-b", "2026-01-02T00:00:00Z").await;
    add_direct_chat(
        &pool,
        "session:direct-person:wrote-a:wrote-b",
        ["wrote-a", "wrote-b"],
        &[("wrote-b", "text", "Hi there", false)],
    )
    .await;
    // Writing to the other person's agent is not consent to the person.
    add_contact(&pool, "agentdm-a", "agentdm-b", T0).await;
    add_direct_chat(
        &pool,
        "session:direct-agent:agentdm-a:agentdm-b",
        ["agentdm-a", "agentdm-b"],
        &[("agentdm-b", "text", "Hello agent", false)],
    )
    .await;
    // Agent output, imported history, and deleted messages are not consent.
    add_contact(&pool, "assist-a", "assist-b", T0).await;
    add_direct_chat(
        &pool,
        "session:direct-person:assist-a:assist-b",
        ["assist-a", "assist-b"],
        &[
            ("assist-b", "assistant", "Generated", false),
            (
                "assist-b",
                "text",
                " kordi-cloud-agent-response:eyJ9",
                false,
            ),
            ("assist-b", "canonical-history-import", "Imported", false),
            ("assist-b", "text", "Deleted hello", true),
        ],
    )
    .await;
    add_contact(&pool, "pending-a", "pending-b", T0).await;
    add_request(&pool, "req-pending", "pending-a", "pending-b", "pending").await;
    add_contact(&pool, "declined-a", "declined-b", T0).await;
    add_request(
        &pool,
        "req-declined",
        "declined-a",
        "declined-b",
        "rejected",
    )
    .await;
    add_contact(&pool, "reverse-a", "reverse-b", T0).await;
    add_request(&pool, "req-reverse", "reverse-b", "reverse-a", "pending").await;
    add_contact(&pool, "accepted-a", "accepted-b", T0).await;
    add_request(
        &pool,
        "req-accepted",
        "accepted-b",
        "accepted-a",
        "accepted",
    )
    .await;
    add_contact(&pool, "user", "pip-like", T0).await;
    add_contact(&pool, "support-like", "user", T0).await;
    add_direct_chat(
        &pool,
        "session:direct-system-agent:support-like:user",
        ["support-like", "user"],
        &[("user", "text", "Help", false)],
    )
    .await;
    add_contact(&pool, "self", "self", T0).await;
    let before = contacts(&pool).await;
    let counts = chat_counts(&pool).await;

    apply_migrations(&pool).await.unwrap();
    latest_version(&pool).await;

    assert_eq!(
        outcomes(&pool).await,
        vec![
            row("accepted-a", "accepted-b", "completed_by_peer_consent"),
            row("agentdm-a", "agentdm-b", "converted_to_request"),
            row("assist-a", "assist-b", "converted_to_request"),
            row("declined-a", "declined-b", "dropped_after_decline"),
            row("pending-a", "pending-b", "kept_pending_request"),
            row("reverse-a", "reverse-b", "completed_by_peer_consent"),
            row("self", "self", "dropped_self"),
            row("support-like", "user", "dropped_service"),
            row("user", "pip-like", "dropped_service"),
            row("wrote-a", "wrote-b", "completed_by_peer_consent"),
        ]
    );
    let pairs: Vec<(String, String)> = contacts(&pool)
        .await
        .into_iter()
        .map(|(a, b, _)| (a, b))
        .collect();
    let expected: Vec<(String, String)> = [
        ("accepted-a", "accepted-b"),
        ("accepted-b", "accepted-a"),
        ("mutual-a", "mutual-b"),
        ("mutual-b", "mutual-a"),
        ("reverse-a", "reverse-b"),
        ("reverse-b", "reverse-a"),
        ("wrote-a", "wrote-b"),
        ("wrote-b", "wrote-a"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    assert_eq!(pairs, expected);
    let (completed_at,): (String,) = query_as("SELECT created_at FROM cloud_contacts WHERE account_id='wrote-b' AND peer_account_id='wrote-a'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(
        completed_at, "2026-01-02T00:00:00Z",
        "the completed row keeps the original time"
    );
    let status = |id: &'static str| {
        let pool = pool.clone();
        async move {
            query_as::<_, (String,)>(
                "SELECT status FROM cloud_contact_requests WHERE request_id=$1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .0
        }
    };
    assert_eq!(status("req-pending").await, "pending");
    assert_eq!(status("req-reverse").await, "accepted");
    assert_eq!(status("req-declined").await, "rejected");
    let converted: Vec<(String, String, Option<String>, String)> = query_as("SELECT r.from_account_id,r.to_account_id,r.message,r.created_at FROM cloud_contact_requests r JOIN cloud_contact_consent_backfill b ON b.request_id=r.request_id WHERE b.outcome='converted_to_request' AND r.status='pending' ORDER BY 1")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(
        converted,
        vec![
            ("agentdm-a".into(), "agentdm-b".into(), None, T0.into()),
            ("assist-a".into(), "assist-b".into(), None, T0.into()),
        ]
    );
    assert_eq!(
        chat_counts(&pool).await,
        counts,
        "messages, conversations, and memberships are untouched"
    );

    // Re-running converts nothing new.
    let (snapshot_contacts, snapshot_requests) = (contacts(&pool).await, requests(&pool).await);
    assert_eq!(convert(&pool).await, 0);
    assert_eq!(contacts(&pool).await, snapshot_contacts);
    assert_eq!(requests(&pool).await, snapshot_requests);

    // Requests may now be withdrawn; a request to oneself is still refused.
    execute(
        &pool,
        "UPDATE cloud_contact_requests SET status='withdrawn' WHERE request_id='req-pending'",
    )
    .await;
    assert!(query("INSERT INTO cloud_contact_requests(request_id,from_account_id,to_account_id,status,created_at) VALUES('req-self','self','self','pending',$1)")
        .bind(T0).execute(&pool).await.is_err());
    execute(
        &pool,
        "UPDATE cloud_contact_requests SET status='pending' WHERE request_id='req-pending'",
    )
    .await;

    // A row written later by an older replica is converted on the next run.
    add_contact(&pool, "mutual-a", "declined-b", T0).await;
    execute(&pool, "INSERT INTO cloud_account_blocks(blocker_account_id,blocked_account_id) VALUES('declined-b','mutual-a')").await;
    assert_eq!(convert(&pool).await, 1);
    assert!(outcomes(&pool)
        .await
        .contains(&row("mutual-a", "declined-b", "dropped_blocked")));

    // The archive restores the original rows exactly.
    let (reverted,): (i32,) = query_as("SELECT cloud_revert_contact_consent_backfill()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(reverted, 11);
    let mut restored = before.clone();
    restored.push(("mutual-a".into(), "declined-b".into(), T0.into()));
    restored.sort();
    assert_eq!(contacts(&pool).await, restored);
    assert_eq!(status("req-reverse").await, "pending");
    let (converted_left,): (i64,) = query_as("SELECT count(*) FROM cloud_contact_requests r JOIN cloud_contact_consent_backfill b ON b.request_id=r.request_id WHERE b.outcome='converted_to_request'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(converted_left, 0);
    let (again,): (i32,) = query_as("SELECT cloud_revert_contact_consent_backfill()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(again, 0);
    assert_eq!(chat_counts(&pool).await, counts);

    // Nothing deletes archive rows on its own. An operator's purge counts
    // first by default, refuses to cut the 90 days short, and then deletes.
    let archived = || async {
        query_as::<_, (i64,)>("SELECT count(*) FROM cloud_contact_consent_backfill")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0
    };
    let total = archived().await;
    execute(&pool, "UPDATE cloud_contact_consent_backfill SET recorded_at = now() - interval '91 days' WHERE account_id = 'self'").await;
    let purge = |sql: &'static str| {
        let pool = pool.clone();
        async move {
            query_as::<_, (i64,)>(sql)
                .fetch_one(&pool)
                .await
                .map(|row| row.0)
        }
    };
    let dry_run = "SELECT cloud_purge_contact_consent_backfill(interval '90 days')";
    assert_eq!(purge(dry_run).await.unwrap(), 1);
    assert_eq!(archived().await, total);
    assert!(
        purge("SELECT cloud_purge_contact_consent_backfill(interval '30 days', true)")
            .await
            .is_err()
    );
    let apply = "SELECT cloud_purge_contact_consent_backfill(interval '90 days', true)";
    assert_eq!(purge(apply).await.unwrap(), 1);
    assert_eq!(archived().await, total - 1);
    assert_eq!(purge(apply).await.unwrap(), 0);
}
