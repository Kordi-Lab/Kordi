//! Deleting an account (owner decision B1).

use super::*;
use crate::chat_sync::models::SendMessageRequest;
use crate::deleted_account::DELETED_ACCOUNT_ID;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

const PREFIX: &str = "kordi-cloud-group:";

fn envelope(value: &Value) -> String {
    format!(
        "{PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    )
}

fn decoded_text(content: &Value) -> String {
    let text = content["blocks"][0]["text"].as_str().unwrap_or_default();
    match text.strip_prefix(PREFIX) {
        Some(encoded) => String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap(),
        None => text.to_string(),
    }
}

async fn conversation(
    pool: &PgPool,
    kind: &str,
    legacy_session_id: Option<String>,
    creator: &str,
    members: &[(&str, &str)],
) -> uuid::Uuid {
    let id = uuid::Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations \
         (conversation_id, kind, created_by_account_id, client_operation_id, \
          creation_fingerprint, legacy_session_id) \
         VALUES ($1, $2, $3, $4, 'test', $5)",
    )
    .bind(id)
    .bind(kind)
    .bind(creator)
    .bind(uuid::Uuid::new_v4())
    .bind(legacy_session_id)
    .execute(pool)
    .await
    .unwrap();
    for (offset, (member, role)) in members.iter().enumerate() {
        query(
            "INSERT INTO cloud_chat_conversation_members \
             (conversation_id, account_id, role, joined_at) \
             VALUES ($1, $2, $3, now() - make_interval(mins => $4))",
        )
        .bind(id)
        .bind(member)
        .bind(role)
        .bind(100 - offset as i32)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn send(pool: &PgPool, sender: &str, conversation_id: uuid::Uuid, text: &str) -> uuid::Uuid {
    crate::chat_sync::store::send_message(
        pool,
        sender,
        conversation_id,
        SendMessageRequest {
            client_message_id: uuid::Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}],
                "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send message")
    .value
    .id
}

fn group_envelope(
    space: &str,
    sender: (&str, &str),
    people: &[(&str, &str)],
    text: &str,
) -> String {
    envelope(&json!({
        "kind": "message",
        "groupSpaceId": space,
        "actor": {"accountId": sender.0, "displayName": sender.1},
        "participants": people.iter().map(|(id, name)| json!({"accountId": id, "displayName": name})).collect::<Vec<_>>(),
        "message": {"senderKind": "person", "senderAccountId": sender.0,
                    "senderDisplayName": sender.1, "text": text},
    }))
}

async fn sync_events(pool: &PgPool, account_id: &str) -> Vec<(String, Option<uuid::Uuid>, Value)> {
    query_as(
        "SELECT event_type, conversation_id, payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 ORDER BY stream_seq",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn deleting_an_account_keeps_shared_groups_and_removes_the_person() {
    let harness = harness().await;
    let password = strong_password();
    let dana = harness.account(Some(&password), true).await;
    let kim = harness.account(None, true).await;
    let lee = harness.account(None, true).await;
    query("UPDATE cloud_accounts SET display_name = 'Dana Doe' WHERE account_id = $1")
        .bind(&dana.account_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (mac, _) = harness.app_sign_in(&dana.account_id, &dana.device_id).await;
    let now = Utc::now().to_rfc3339();
    for (a, b) in [(&dana, &kim), (&kim, &dana)] {
        query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3)",
        )
        .bind(&a.account_id)
        .bind(&b.account_id)
        .bind(&now)
        .execute(&harness.pool)
        .await
        .unwrap();
    }
    let pool = &harness.pool;
    // A group Dana owns with Kim, then Lee as an admin who joined later.
    let group = conversation(
        pool,
        "group",
        None,
        &dana.account_id,
        &[
            (&dana.account_id, "owner"),
            (&kim.account_id, "member"),
            (&lee.account_id, "admin"),
        ],
    )
    .await;
    let space = group.to_string();
    let people = [
        (dana.account_id.as_str(), "Dana Doe"),
        (kim.account_id.as_str(), "Kim"),
        (lee.account_id.as_str(), "Lee"),
    ];
    let danas_message = send(
        pool,
        &dana.account_id,
        group,
        &group_envelope(&space, people[0], &people, "Dana's plan"),
    )
    .await;
    let kims_message = send(
        pool,
        &kim.account_id,
        group,
        &group_envelope(&space, people[1], &people, "Sounds good"),
    )
    .await;
    let attachment = format!("att_{}", uuid::Uuid::new_v4().simple());
    let object_key = format!("attachments/{}/{attachment}", dana.account_id);
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, size_bytes, \
         content_type, sha256_hex, created_at, finalized_at) \
         VALUES ($1, $2, $3, 4, 'image/png', 'abcd', $4, $4)",
    )
    .bind(&attachment)
    .bind(&dana.account_id)
    .bind(&object_key)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_message_attachments (message_id, attachment_id, position) \
         VALUES ($1, $2, 0)",
    )
    .bind(danas_message)
    .bind(&attachment)
    .execute(pool)
    .await
    .unwrap();
    // A group where nobody else is left, and a direct chat with Kim.
    let alone = conversation(
        pool,
        "group",
        None,
        &dana.account_id,
        &[(&dana.account_id, "owner")],
    )
    .await;
    send(pool, &dana.account_id, alone, "Notes to self").await;
    let direct = conversation(
        pool,
        "direct",
        Some(format!(
            "session:direct-person:{}:{}",
            dana.account_id, kim.account_id
        )),
        &dana.account_id,
        &[(&dana.account_id, "member"), (&kim.account_id, "member")],
    )
    .await;
    send(pool, &kim.account_id, direct, "Private note to Dana").await;

    // The current password is required.
    let (status, body) = harness
        .post("/delete", Auth::Bearer(&dana.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "current_password_required");
    let (status, body) = harness
        .post(
            "/delete",
            Auth::Bearer(&dana.token),
            json!({ "currentPassword": strong_password() }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "invalid_current_password");

    let (status, body) = harness
        .post(
            "/delete",
            Auth::Bearer(&dana.token),
            json!({ "currentPassword": password }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    // The account, its sessions and its contacts are gone.
    assert_eq!(
        harness.me_status(&dana.token).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(harness.me_status(&mac).await, StatusCode::UNAUTHORIZED);
    let (accounts,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_accounts WHERE account_id = $1")
        .bind(&dana.account_id)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(accounts, 0);
    let (contacts,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_contacts WHERE account_id = $1 OR peer_account_id = $1",
    )
    .bind(&dana.account_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(contacts, 0);

    // The shared group passed to the admin and keeps Dana's message, from
    // the Deleted account, without her name or attachment.
    let members: Vec<(String, String, String)> = query_as(
        "SELECT account_id, role, membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 ORDER BY account_id",
    )
    .bind(group)
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(members.contains(&(lee.account_id.clone(), "owner".into(), "active".into())));
    assert!(members.contains(&(kim.account_id.clone(), "member".into(), "active".into())));
    assert!(members.contains(&(DELETED_ACCOUNT_ID.into(), "member".into(), "left".into())));
    assert!(members.iter().all(|(id, _, _)| id != &dana.account_id));
    let messages: Vec<(uuid::Uuid, String, Value)> = query_as(
        "SELECT message_id, sender_account_id, content FROM cloud_chat_messages \
         WHERE conversation_id = $1",
    )
    .bind(group)
    .fetch_all(pool)
    .await
    .unwrap();
    for (id, sender, content) in &messages {
        let text = decoded_text(content);
        assert!(!text.contains("Dana Doe"), "{text}");
        assert!(!text.contains(&dana.account_id), "{text}");
        if *id == danas_message {
            assert_eq!(sender, DELETED_ACCOUNT_ID);
            assert!(text.contains("Deleted account"), "{text}");
        }
        if *id == kims_message {
            assert_eq!(sender, &kim.account_id);
        }
    }
    let (links,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_message_attachments WHERE message_id = $1")
            .bind(danas_message)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(links, 0);
    let (queued,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_object_deletions WHERE object_key = $1")
            .bind(&object_key)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(queued, 1);

    // Kim's devices learn the new member list and the changed messages.
    let events = sync_events(pool, &kim.account_id).await;
    let update = events
        .iter()
        .rev()
        .find(|(kind, id, _)| kind == "membership.updated" && *id == Some(group))
        .expect("membership update");
    let listed = update.2["conversation"]["members"].to_string();
    assert!(listed.contains("Deleted account"), "{listed}");
    assert!(!listed.contains("Dana Doe"), "{listed}");
    assert!(events
        .iter()
        .any(|(kind, _, payload)| kind == "message.updated"
            && payload["message"]["id"] == json!(danas_message)
            && payload["message"]["sender_account_id"] == DELETED_ACCOUNT_ID));

    // The group nobody else was in is deleted; the direct chat is emptied
    // and removed from Kim's devices.
    let (alone_left,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_conversations WHERE conversation_id = $1")
            .bind(alone)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(alone_left, 0);
    let (direct_messages,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_messages WHERE conversation_id = $1")
            .bind(direct)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(direct_messages, 0);
    let (kim_state,): (String,) = query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(direct)
    .bind(&kim.account_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(kim_state, "removed");
    assert!(events
        .iter()
        .any(|(kind, id, _)| kind == "membership.removed" && *id == Some(direct)));

    // The audit record has counts only.
    let audits: Vec<(Option<String>, String)> = query_as(
        "SELECT account_id, metadata_json FROM cloud_audit_events \
         WHERE event_type = 'account.deleted' AND metadata_json LIKE '%\"groupsTransferred\":1%'",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(!audits.is_empty());
    for (account_id, metadata) in audits {
        assert!(account_id.is_none());
        assert!(!metadata.contains(&dana.account_id) && !metadata.contains(&dana.email));
    }
    let (left_behind,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_audit_events WHERE account_id = $1")
            .bind(&dana.account_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(left_behind, 0);
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_account_without_a_password_deletes_with_an_emailed_code() {
    let harness = harness().await;
    let account = harness.account(None, true).await;
    harness.age_session(&account.token_id, 60).await;
    let (status, body) = harness
        .post("/delete", Auth::Web(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "reauthentication_required");
    let (status, challenge) = harness
        .post("/password/code", Auth::Web(&account.token), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    let (_, code) = harness.sent_codes().pop().unwrap();
    let verification_id = challenge["verificationId"].as_str().unwrap();
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let (status, body) = harness
        .post(
            "/delete",
            Auth::Web(&account.token),
            json!({ "verificationId": verification_id, "verificationCode": wrong }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(harness.me_status(&account.token).await, StatusCode::OK);
    let (status, body) = harness
        .post(
            "/delete",
            Auth::Web(&account.token),
            json!({ "verificationId": verification_id, "verificationCode": code }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        harness.me_status(&account.token).await,
        StatusCode::UNAUTHORIZED
    );
}
