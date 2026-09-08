use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

async fn group(
    pool: &PgPool,
    key: &str,
    shared: Option<&str>,
    owner_title: Option<&str>,
    peer_title: Option<&str>,
) -> Uuid {
    let id = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,shared_title,version,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id,group_space_id,created_at,updated_at) VALUES($1,'group',$2,4,'fixture-owner',$3,$4,$5,$6,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
        .bind(id).bind(shared).bind(Uuid::new_v4()).bind(key)
        .bind(format!("session:group:{key}")).bind(format!("space:{key}"))
        .execute(pool).await.unwrap();
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id,role,personal_title,preferences_version,joined_at) VALUES($1,'fixture-owner','owner',$2,7,'2026-01-01T00:00:00Z'),($1,'fixture-peer','member',$3,11,'2026-01-01T00:00:00Z')")
        .bind(id).bind(owner_title).bind(peer_title).execute(pool).await.unwrap();
    id
}

fn control(key: &str, title: &str, nested: bool) -> Value {
    let mut envelope = json!({
        "kind":"session-title-update", "groupId":format!("session:group:{key}"),
        "groupSpaceId":format!("space:{key}"), "groupTitle":title,
        "actor":{"accountId":"fixture-owner","role":"admin"}
    });
    if nested {
        envelope["groupTitle"] = json!("Parent group name, not the channel title");
        envelope["sessionTitle"] = json!({
            "title":title, "titleSource":"manual", "titleRevision":2,
            "titlePolicyVersion":1, "updatedAtMs":1767312000000_i64,
            "updatedByAccountId":"fixture-owner"
        });
    }
    envelope
}

async fn message(pool: &PgPool, id: Uuid, sequence: i64, sender: &str, body: &str) {
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'2026-01-02T00:00:00Z'::timestamptz + $3 * interval '1 second')")
        .bind(Uuid::new_v4()).bind(id).bind(sequence).bind(sender).bind(Uuid::new_v4())
        .bind(format!("title-fixture-{sequence}"))
        .bind(json!({"schema":1,"blocks":[{"type":"text","text":body}]}))
        .execute(pool).await.unwrap();
}

async fn rename(pool: &PgPool, id: Uuid, sequence: i64, sender: &str, envelope: Value) {
    let body = format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    );
    message(pool, id, sequence, sender, &body).await;
}

async fn title(pool: &PgPool, id: Uuid) -> Option<String> {
    query_as::<_, (Option<String>,)>(
        "SELECT shared_title FROM cloud_chat_conversations WHERE conversation_id=$1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

async fn members(pool: &PgPool) -> Vec<(Uuid, String, Value)> {
    query_as("SELECT conversation_id,account_id,to_jsonb(m) FROM cloud_chat_conversation_members m ORDER BY conversation_id,account_id")
        .fetch_all(pool).await.unwrap()
}

async fn snapshot(pool: &PgPool) -> Value {
    query_as::<_, (Value,)>("SELECT jsonb_build_object('conversations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY conversation_id) FROM cloud_chat_conversations c),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY conversation_id,account_id) FROM cloud_chat_conversation_members m),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY message_id) FROM cloud_chat_messages m),'heads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY account_id) FROM cloud_chat_user_sync_heads h))")
        .fetch_one(pool).await.unwrap().0
}

async fn known_default(pool: &PgPool, id: Uuid) {
    query("UPDATE cloud_chat_conversations SET updated_at=(SELECT applied_at FROM cloud_schema_versions WHERE version=79) WHERE conversation_id=$1")
        .bind(id).execute(pool).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_75_preserves_shared_and_private_group_names() {
    let pool = fixture(75).await;
    let named = group(
        &pool,
        "named",
        Some("Planning"),
        Some("My planning"),
        Some("Peer planning"),
    )
    .await;
    let private = group(
        &pool,
        "private",
        None,
        Some("Owner private label"),
        Some("Peer private label"),
    )
    .await;
    let equal = group(
        &pool,
        "equal-private",
        None,
        Some("Still private"),
        Some("Still private"),
    )
    .await;
    let restored = group(&pool, "restored", None, None, None).await;
    rename(
        &pool,
        restored,
        1,
        "fixture-owner",
        control("restored", "Agreed channel name", true),
    )
    .await;
    let explicit_number = group(&pool, "explicit-number", Some("Channel 7"), None, None).await;
    let mut explicit_titles = vec![named, explicit_number];
    for (index, shared) in [
        "Session",
        "New chat",
        "New session",
        "Untitled session",
        "session",
        "NEW CHAT",
        " New session ",
        "  UNTITLED SESSION  ",
    ]
    .into_iter()
    .enumerate()
    {
        explicit_titles.push(
            group(
                &pool,
                &format!("explicit-title-{index}"),
                Some(shared),
                None,
                None,
            )
            .await,
        );
    }
    let before_titles: Vec<(Uuid, Option<String>, i64, String)> = query_as(
        "SELECT conversation_id,shared_title,version,updated_at::text FROM cloud_chat_conversations WHERE conversation_id=ANY($1) ORDER BY conversation_id",
    ).bind(&explicit_titles).fetch_all(&pool).await.unwrap();
    let before_members = members(&pool).await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after_titles: Vec<(Uuid, Option<String>, i64, String)> = query_as(
        "SELECT conversation_id,shared_title,version,updated_at::text FROM cloud_chat_conversations WHERE conversation_id=ANY($1) ORDER BY conversation_id",
    ).bind(&explicit_titles).fetch_all(&pool).await.unwrap();
    assert_eq!(
        after_titles, before_titles,
        "explicit titles, revisions, and timestamps must survive every pending migration"
    );
    assert_eq!(
        members(&pool).await,
        before_members,
        "private labels and preference revisions are user data"
    );
    assert_eq!(title(&pool, named).await.as_deref(), Some("Planning"));
    assert_eq!(title(&pool, private).await.as_deref(), Some("Channel 1"));
    assert_eq!(
        title(&pool, equal).await,
        Some("Channel 1".into()),
        "equal private labels do not establish or replace a shared title"
    );
    assert_eq!(
        title(&pool, restored).await.as_deref(),
        Some("Agreed channel name")
    );
    assert_eq!(
        title(&pool, explicit_number).await.as_deref(),
        Some("Channel 7")
    );
    let after = snapshot(&pool).await;
    apply_migrations(&pool).await.unwrap();
    assert_eq!(
        snapshot(&pool).await,
        after,
        "repeated startup must not churn titles or revisions"
    );
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_89_repairs_only_proven_defaults_and_authenticated_titles() {
    let pool = fixture(89).await;
    execute(&pool, "INSERT INTO cloud_chat_user_sync_heads(account_id,last_seq,min_seq) VALUES('fixture-owner',5,2),('fixture-peer',7,3)").await;
    let nested = group(&pool, "nested", Some("Channel 1"), None, None).await;
    let legacy = group(&pool, "legacy", Some("Channel 2"), None, None).await;
    let current = group(&pool, "current", Some("Current shared rename"), None, None).await;
    let explicit_number = group(&pool, "number", Some("Channel 9"), None, None).await;
    let explicit_generic = group(&pool, "generic", Some("Session"), None, None).await;
    let private = group(
        &pool,
        "private",
        Some("Channel 3"),
        Some("Owner secret"),
        Some("Peer secret"),
    )
    .await;
    let malformed = group(&pool, "malformed", Some("Channel 4"), None, None).await;
    let blank = group(&pool, "blank", None, None, None).await;
    for id in [nested, legacy, private, malformed] {
        known_default(&pool, id).await;
    }
    rename(
        &pool,
        nested,
        1,
        "fixture-owner",
        control("nested", "Previous public name", false),
    )
    .await;
    rename(
        &pool,
        nested,
        2,
        "fixture-owner",
        control("nested", "Recovered nested title", true),
    )
    .await;
    rename(
        &pool,
        legacy,
        1,
        "fixture-owner",
        control("legacy", "Recovered legacy title", false),
    )
    .await;
    rename(
        &pool,
        current,
        1,
        "fixture-owner",
        control("current", "Obsolete rename", true),
    )
    .await;
    rename(
        &pool,
        explicit_number,
        1,
        "fixture-owner",
        control("number", "Old title", true),
    )
    .await;
    rename(
        &pool,
        explicit_generic,
        1,
        "fixture-owner",
        control("generic", "Old generic title", true),
    )
    .await;
    let mut later_forgery = control("nested", "Later forged name", true);
    later_forgery["actor"]["accountId"] = json!("fixture-peer");
    rename(&pool, nested, 3, "fixture-owner", later_forgery).await;
    let mut by_id = control("blank", "Recovered UUID channel", true);
    by_id["groupId"] = json!(blank.to_string());
    rename(&pool, blank, 1, "fixture-owner", by_id).await;

    // These must neither fail the migration nor become public channel names.
    message(
        &pool,
        malformed,
        1,
        "fixture-owner",
        "kordi-cloud-group:not-valid-base64!",
    )
    .await;
    message(
        &pool,
        malformed,
        2,
        "fixture-owner",
        "kordi-cloud-group:e30",
    )
    .await;
    let mut wrong_actor = control("malformed", "Forged actor", true);
    wrong_actor["actor"]["accountId"] = json!("fixture-peer");
    rename(&pool, malformed, 3, "fixture-owner", wrong_actor).await;
    let mut member_claim = control("malformed", "Member pretending to be admin", true);
    member_claim["actor"]["accountId"] = json!("fixture-peer");
    rename(&pool, malformed, 4, "fixture-peer", member_claim).await;
    rename(
        &pool,
        malformed,
        5,
        "fixture-owner",
        control("another-session", "Wrong session", true),
    )
    .await;
    let mut group_only = control("malformed", "Group name is not channel name", false);
    group_only["kind"] = json!("group-title-update");
    rename(&pool, malformed, 6, "fixture-owner", group_only).await;
    let mut invalid_title = control("malformed", "", true);
    invalid_title["sessionTitle"]["title"] = json!({"not":"a string"});
    invalid_title["groupTitle"] = Value::Null;
    rename(&pool, malformed, 7, "fixture-owner", invalid_title).await;
    message(&pool, malformed, 8, "fixture-owner", "kordi-cloud-group:ew").await;
    message(&pool, malformed, 9, "fixture-owner", "kordi-cloud-group:_w").await;
    let before_members = members(&pool).await;
    let before_messages: Vec<(Uuid, Value)> =
        query_as("SELECT message_id,to_jsonb(m) FROM cloud_chat_messages m ORDER BY message_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    for (id, expected) in [
        (nested, "Recovered nested title"),
        (legacy, "Recovered legacy title"),
        (current, "Current shared rename"),
        (explicit_number, "Channel 9"),
        (explicit_generic, "Session"),
        (malformed, "Channel 4"),
        (blank, "Recovered UUID channel"),
    ] {
        assert_eq!(title(&pool, id).await.as_deref(), Some(expected));
    }
    assert_eq!(title(&pool, private).await.as_deref(), Some("Channel 3"));
    assert_eq!(members(&pool).await, before_members);
    let heads: Vec<(String, i64, i64)> = query_as(
        "SELECT account_id,last_seq,min_seq FROM cloud_chat_user_sync_heads ORDER BY account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        heads,
        vec![
            ("fixture-owner".into(), 6, 6),
            ("fixture-peer".into(), 8, 8)
        ],
        "affected clients must rebootstrap exactly once"
    );
    let after_messages: Vec<(Uuid, Value)> =
        query_as("SELECT message_id,to_jsonb(m) FROM cloud_chat_messages m ORDER BY message_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        after_messages, before_messages,
        "recovery must not rewrite its historical evidence"
    );
    let after = snapshot(&pool).await;
    apply_migrations(&pool).await.unwrap();
    assert_eq!(snapshot(&pool).await, after);
}
