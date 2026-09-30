use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

const GROUP_PREFIX: &str = "kordi-cloud-group:";

struct Group {
    owner: String,
    member: String,
    conversation_id: Uuid,
    session_id: String,
}

async fn group(pool: &PgPool, label: &str) -> Group {
    let owner = account(pool, &format!("{label}-owner")).await;
    let member = account(pool, &format!("{label}-member")).await;
    connect_accounts(pool, &owner, &member).await;
    let session_id = format!("session:group:{}", Uuid::now_v7());
    let created = store::create_conversation(
        pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Sender identity".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: vec![member.clone()],
        },
    )
    .await
    .expect("create group");
    Group {
        owner,
        member,
        conversation_id: created.value.id,
        session_id,
    }
}

async fn custom_agent(pool: &PgPool, owner: &str, name: &str, status: &str) -> String {
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_definitions(agent_id, owner_account_id, status, name, role, \
         system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
         avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, 'research', 'test', 'test', 'test', 'generated', 'thumbs', $1, \
         'test', 1, 'test')",
    )
    .bind(&agent_id)
    .bind(owner)
    .bind(status)
    .bind(name)
    .execute(pool)
    .await
    .expect("create custom agent");
    agent_id
}

fn envelope(group: &Group, actor: &str, message: Value) -> String {
    let body = json!({
        "kind": "group-message",
        "groupId": group.session_id,
        "groupTitle": null,
        "createdByAccountId": group.owner,
        "actor": { "accountId": actor, "displayName": "Actor" },
        "participants": [
            { "accountId": group.owner, "displayName": "Owner" },
            { "accountId": group.member, "displayName": "Member" }
        ],
        "message": message
    });
    format!("{GROUP_PREFIX}{}", URL_SAFE_NO_PAD.encode(body.to_string()))
}

fn request(content: Value) -> SendMessageRequest {
    SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content,
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    }
}

fn stored_message(snapshot: &kordi_cloud_server::chat_sync::models::MessageSnapshot) -> Value {
    let text = snapshot.content["blocks"][0]["text"]
        .as_str()
        .expect("stored envelope text");
    let encoded = text
        .strip_prefix(GROUP_PREFIX)
        .expect("stored group prefix");
    let decoded: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).expect("stored base64"))
            .expect("stored envelope json");
    decoded["message"].clone()
}

async fn send(
    pool: &PgPool,
    group: &Group,
    sender: &str,
    body: String,
) -> Result<Value, StoreError> {
    store::send_message(pool, sender, group.conversation_id, request(content(&body)))
        .await
        .map(|outcome| stored_message(&outcome.value))
}

fn rejected(result: Result<Value, StoreError>) -> bool {
    matches!(result, Err(StoreError::InvalidInput(_)))
}

#[tokio::test]
async fn group_envelope_senders_are_bound_to_the_signed_in_account() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping group sender identity test");
        return;
    };
    let group = group(&pool, "sender-binding").await;
    let owner_agent = custom_agent(&pool, &group.owner, "Owner Research", "active").await;

    // Another member's account, agent, or actor identity is refused.
    for message in [
        json!({ "id": "m1", "senderAccountId": group.owner, "text": "hi", "createdAtMs": 1 }),
        json!({ "id": "m2", "senderAccountId": group.owner, "senderKind": "agent",
            "text": "hi", "createdAtMs": 1 }),
        json!({ "id": "m3", "senderAccountId": group.member, "senderKind": "agent",
            "senderAgentId": owner_agent, "text": "hi", "createdAtMs": 1 }),
        json!({ "id": "m4", "senderAccountId": group.member, "senderKind": "agent",
            "senderAgentId": format!("cloud-agent:{}", group.owner), "text": "hi",
            "createdAtMs": 1 }),
        json!({ "id": "m5", "senderAccountId": 7, "text": "hi", "createdAtMs": 1 }),
    ] {
        let body = envelope(&group, &group.member, message.clone());
        assert!(
            rejected(send(&pool, &group, &group.member, body).await),
            "{message}"
        );
    }
    let other_actor = envelope(
        &group,
        &group.owner,
        json!({ "id": "m6", "senderAccountId": group.member, "text": "hi", "createdAtMs": 1 }),
    );
    assert!(rejected(
        send(&pool, &group, &group.member, other_actor).await
    ));

    // Human display fields are derived from the sender's account.
    let human = send(
        &pool,
        &group,
        &group.member,
        envelope(
            &group,
            &group.member,
            json!({ "id": "m7", "senderAccountId": group.member, "senderKind": "human",
                "senderDisplayName": "Owner", "senderOwnerName": "Owner",
                "senderOwnerAccountId": group.owner, "senderAgentId": owner_agent,
                "text": "hello", "createdAtMs": 1 }),
        ),
    )
    .await
    .expect("member message");
    assert_eq!(human["senderAccountId"], group.member.as_str());
    assert_eq!(human["senderKind"], "human");
    assert_eq!(human["senderDisplayName"], "sender-binding-member");
    assert!(human.get("senderOwnerName").is_none());
    assert!(human.get("senderOwnerAccountId").is_none());
    assert!(human.get("senderAgentId").is_none());

    // A missing sender is filled in from the session.
    let unnamed = send(
        &pool,
        &group,
        &group.member,
        envelope(
            &group,
            &group.member,
            json!({ "id": "m8", "text": "no sender", "createdAtMs": 1 }),
        ),
    )
    .await
    .expect("message without sender");
    assert_eq!(unnamed["senderAccountId"], group.member.as_str());

    // Agents owned by the sender keep server-derived names.
    let custom = send(
        &pool,
        &group,
        &group.owner,
        envelope(
            &group,
            &group.owner,
            json!({ "id": "m9", "senderAccountId": group.owner, "senderKind": "agent",
                "senderAgentId": owner_agent, "senderDisplayName": "Somebody Else",
                "senderOwnerName": "Somebody Else", "text": "report", "createdAtMs": 1 }),
        ),
    )
    .await
    .expect("owner custom agent message");
    assert_eq!(custom["senderKind"], "agent");
    assert_eq!(custom["senderAgentId"], owner_agent.as_str());
    assert_eq!(custom["senderDisplayName"], "Owner Research");
    assert_eq!(custom["senderOwnerAccountId"], group.owner.as_str());
    assert_eq!(custom["senderOwnerName"], "sender-binding-owner");

    let legacy_default = send(
        &pool,
        &group,
        &group.owner,
        envelope(
            &group,
            &group.owner,
            json!({ "id": "m10", "senderAccountId": group.owner, "senderKind": "agent",
                "senderAgentId": "cloud-local-agent", "senderDisplayName": "Somebody Else",
                "text": "default", "createdAtMs": 1 }),
        ),
    )
    .await
    .expect("owner default agent message");
    assert_eq!(legacy_default["senderDisplayName"], "Kordi");
    assert_eq!(legacy_default["senderOwnerAccountId"], group.owner.as_str());

    // An archived agent still belongs to its owner, so a run admitted before
    // the agent was archived can publish its final state. Another member's
    // archived agent stays refused.
    let archived = custom_agent(&pool, &group.owner, "Archived", "archived").await;
    let late = send(
        &pool,
        &group,
        &group.owner,
        envelope(
            &group,
            &group.owner,
            json!({ "id": "m11", "senderAccountId": group.owner, "senderKind": "agent",
                "senderAgentId": archived, "text": "late", "createdAtMs": 1 }),
        ),
    )
    .await
    .expect("owner archived agent message");
    assert_eq!(late["senderDisplayName"], "Archived");
    assert!(rejected(
        send(
            &pool,
            &group,
            &group.member,
            envelope(
                &group,
                &group.member,
                json!({ "id": "m12", "senderAccountId": group.member, "senderKind": "agent",
                    "senderAgentId": archived, "text": "late", "createdAtMs": 1 }),
            ),
        )
        .await
    ));
}

fn decoded_envelope(snapshot: &kordi_cloud_server::chat_sync::models::MessageSnapshot) -> Value {
    let text = snapshot.content["blocks"][0]["text"]
        .as_str()
        .expect("stored envelope text");
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(
                text.strip_prefix(GROUP_PREFIX)
                    .expect("stored group prefix"),
            )
            .expect("stored base64"),
    )
    .expect("stored envelope json")
}

fn joined_text(content: &Value) -> String {
    content["blocks"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn senders_without_a_display_name_show_their_account_id() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping sender display name test");
        return;
    };
    let group = group(&pool, "unnamed-sender").await;
    query("UPDATE cloud_accounts SET display_name = NULL WHERE account_id = $1")
        .bind(&group.member)
        .execute(&pool)
        .await
        .expect("clear display name");
    let sent = store::send_message(
        &pool,
        &group.member,
        group.conversation_id,
        request(content(&envelope(
            &group,
            &group.member,
            json!({ "id": "n1", "senderAccountId": group.member, "text": "hi",
                "createdAtMs": 1 }),
        ))),
    )
    .await
    .expect("member message");
    let envelope = decoded_envelope(&sent.value);
    assert_eq!(envelope["actor"]["displayName"], group.member.as_str());
    let member = envelope["participants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|participant| participant["accountId"] == group.member.as_str())
        .expect("member participant");
    assert_eq!(member["displayName"], group.member.as_str());
    assert!(envelope["message"].get("senderDisplayName").is_none());
}

#[tokio::test]
async fn edits_cannot_join_message_blocks_into_an_envelope() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping split envelope edit test");
        return;
    };
    let group = group(&pool, "edit-split").await;
    let named_owner = envelope(
        &group,
        &group.owner,
        json!({ "id": "e1", "senderAccountId": group.owner, "senderKind": "human",
            "senderDisplayName": "Owner", "text": "hello", "createdAtMs": 1 }),
    );
    let tail = named_owner
        .strip_prefix("kordi-cloud-")
        .unwrap()
        .to_string();
    let sent = store::send_message(
        &pool,
        &group.member,
        group.conversation_id,
        request(json!({ "schema": 1, "blocks": [
            { "type": "text", "text": "hello" },
            { "type": "text", "text": tail }
        ] })),
    )
    .await
    .expect("plain two-block message");
    let edited = store::edit_message(
        &pool,
        &group.member,
        group.conversation_id,
        sent.value.id,
        UpdateMessageRequest {
            expected_version: sent.value.version,
            text: "kordi-cloud-".to_string(),
        },
    )
    .await;
    assert!(matches!(edited, Err(StoreError::InvalidInput(_))));
    let stored = store::load_message_snapshot(&pool, sent.value.id)
        .await
        .expect("load message");
    assert_eq!(stored.version, sent.value.version);
    assert!(!joined_text(&stored.content).starts_with(GROUP_PREFIX));

    // An ordinary edit of the same message still works.
    let edited = store::edit_message(
        &pool,
        &group.member,
        group.conversation_id,
        sent.value.id,
        UpdateMessageRequest {
            expected_version: sent.value.version,
            text: "hi there".to_string(),
        },
    )
    .await
    .expect("plain edit");
    assert_eq!(edited.content["blocks"][0]["text"], "hi there");
}

async fn voice_message(
    pool: &PgPool,
    group: &Group,
    sender: &str,
) -> (
    kordi_cloud_server::chat_sync::models::MessageSnapshot,
    String,
) {
    let media = format!("att-{}", Uuid::new_v4());
    query(
        "INSERT INTO cloud_attachments(attachment_id, owner_account_id, object_key, created_at, \
         finalized_at, content_type, detected_content_type, size_bytes) \
         VALUES ($1, $2, $1, $3, $3, 'audio/mp4', 'audio/mp4', 2048)",
    )
    .bind(&media)
    .bind(sender)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .expect("voice attachment");
    let sent = store::send_message(
        pool,
        sender,
        group.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "voice".to_string(),
            reply_to_message_id: None,
            attachment_ids: vec![media.clone()],
            content: json!({ "schema": 1, "blocks": [
                { "type": "text", "text": "" },
                { "type": "voice", "mediaId": media, "mimeType": "audio/mp4",
                  "durationMs": 2000, "waveformSamples": [0.2], "transcript": "",
                  "transcription": { "status": "failed", "sourceVersion": media,
                    "engine": "apple-speech-v1", "attempts": 1 } }
            ] }),
        },
    )
    .await
    .expect("voice message")
    .value;
    (sent, media)
}

fn transcript_request(
    sent: &kordi_cloud_server::chat_sync::models::MessageSnapshot,
    media: &str,
    transcript: String,
) -> store::UpdateVoiceTranscriptRequest {
    store::UpdateVoiceTranscriptRequest {
        expected_version: sent.version,
        media_id: media.to_string(),
        transcript,
        transcription: json!({ "status": "ready", "sourceVersion": media,
            "engine": "apple-speech-v1", "language": "en-US", "attempts": 2 }),
    }
}

#[tokio::test]
async fn voice_transcripts_cannot_replace_a_plain_body_with_an_envelope() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping voice transcript envelope test");
        return;
    };
    let group = group(&pool, "voice-envelope").await;
    let owner_agent = custom_agent(&pool, &group.owner, "Owner Research", "active").await;
    let (sent, media) = voice_message(&pool, &group, &group.member).await;
    let named_agent = envelope(
        &group,
        &group.member,
        json!({ "id": "v1", "senderAccountId": group.member, "senderKind": "agent",
            "senderAgentId": owner_agent, "senderDisplayName": "Owner Research",
            "senderOwnerName": "Owner", "senderOwnerAccountId": group.owner,
            "text": "approved", "createdAtMs": 1 }),
    );
    let updated = store::update_voice_transcript(
        &pool,
        &group.member,
        group.conversation_id,
        sent.id,
        transcript_request(&sent, &media, named_agent),
    )
    .await;
    assert!(matches!(updated, Err(StoreError::InvalidInput(_))));

    let updated = store::update_voice_transcript(
        &pool,
        &group.member,
        group.conversation_id,
        sent.id,
        transcript_request(&sent, &media, "Meet at noon".to_string()),
    )
    .await
    .expect("ordinary transcript");
    assert_eq!(updated.content["blocks"][0]["text"], "Meet at noon");
}

#[tokio::test]
async fn stored_agent_claims_are_checked_against_agent_records_on_read() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping stored agent claim test");
        return;
    };
    let group = group(&pool, "stored-agent").await;
    let owner_agent = custom_agent(&pool, &group.owner, "Owner Research", "active").await;
    let sent = store::send_message(
        &pool,
        &group.member,
        group.conversation_id,
        request(content(&envelope(
            &group,
            &group.member,
            json!({ "id": "a1", "senderAccountId": group.member, "text": "x",
                "createdAtMs": 1 }),
        ))),
    )
    .await
    .expect("member message");
    // Simulate content stored before every write path was normalized: the
    // member's message names the owner's agent and the owner as its owner.
    let stored = envelope(
        &group,
        &group.member,
        json!({ "id": "a1", "senderAccountId": group.member, "senderKind": "agent",
            "senderAgentId": owner_agent, "senderDisplayName": "Owner Research",
            "senderOwnerName": "Owner", "senderOwnerAccountId": group.owner,
            "text": "approved", "createdAtMs": 1 }),
    );
    query("UPDATE cloud_chat_messages SET content = $2 WHERE message_id = $1")
        .bind(sent.value.id)
        .bind(content(&stored))
        .execute(&pool)
        .await
        .expect("store legacy content");
    let loaded = store::load_message_snapshot(&pool, sent.value.id)
        .await
        .expect("load message");
    let message = stored_message(&loaded);
    assert_eq!(message["senderAccountId"], group.member.as_str());
    assert_eq!(message["senderKind"], "human");
    assert_eq!(message["senderDisplayName"], "stored-agent-member");
    assert!(message.get("senderOwnerAccountId").is_none());
    assert!(message.get("senderAgentId").is_none());

    // The same claim split across blocks is repaired as clients read it.
    let (head, tail) = stored.split_at(GROUP_PREFIX.len() - 6);
    query("UPDATE cloud_chat_messages SET content = $2 WHERE message_id = $1")
        .bind(sent.value.id)
        .bind(json!({ "schema": 1, "blocks": [
            { "type": "text", "text": head }, { "type": "text", "text": tail }
        ] }))
        .execute(&pool)
        .await
        .expect("store split content");
    let page = store::history(&pool, &group.owner, group.conversation_id, None, Some(50))
        .await
        .expect("history page");
    let loaded = page
        .messages
        .iter()
        .find(|message| message.id == sent.value.id)
        .expect("split message in history");
    let joined = joined_text(&loaded.content);
    assert_eq!(
        joined,
        loaded.content["blocks"][0]["text"].as_str().unwrap()
    );
    let message = stored_message(loaded);
    assert_eq!(message["senderKind"], "human");
    assert_eq!(message["senderDisplayName"], "stored-agent-member");

    // An agent the stored sender owns shows its current record name.
    let owner_message = send(
        &pool,
        &group,
        &group.owner,
        envelope(
            &group,
            &group.owner,
            json!({ "id": "a2", "senderAccountId": group.owner, "senderKind": "agent",
                "senderAgentId": owner_agent, "text": "report", "createdAtMs": 1 }),
        ),
    )
    .await
    .expect("owner agent message");
    assert_eq!(owner_message["senderDisplayName"], "Owner Research");
    query("UPDATE cloud_agent_definitions SET name = 'Renamed Research' WHERE agent_id = $1")
        .bind(&owner_agent)
        .execute(&pool)
        .await
        .expect("rename agent");
    let page = store::history(&pool, &group.member, group.conversation_id, None, Some(50))
        .await
        .expect("history page");
    let renamed = page
        .messages
        .iter()
        .map(stored_message)
        .find(|message| message["id"] == "a2")
        .expect("owner agent message in history");
    assert_eq!(renamed["senderKind"], "agent");
    assert_eq!(renamed["senderDisplayName"], "Renamed Research");
    assert_eq!(renamed["senderOwnerAccountId"], group.owner.as_str());
}

#[tokio::test]
async fn group_envelopes_outside_the_first_text_block_are_refused() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping group envelope placement test");
        return;
    };
    let group = group(&pool, "envelope-placement").await;
    let body = envelope(
        &group,
        &group.owner,
        json!({ "id": "p1", "senderAccountId": group.owner, "text": "hi", "createdAtMs": 1 }),
    );
    let (head, tail) = body.split_at(10);
    for content in [
        json!({ "schema": 1, "blocks": [
            { "type": "text", "text": "" }, { "type": "text", "text": body }
        ] }),
        json!({ "schema": 1, "blocks": [
            { "type": "text", "text": head }, { "type": "text", "text": tail }
        ] }),
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": format!(" {body}") }] }),
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": format!("{body}=") }] }),
    ] {
        assert!(
            matches!(
                store::send_message(
                    &pool,
                    &group.member,
                    group.conversation_id,
                    request(content.clone())
                )
                .await,
                Err(StoreError::InvalidInput(_))
            ),
            "{content}"
        );
    }
}

#[tokio::test]
async fn stored_group_envelopes_are_presented_as_their_stored_sender() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping stored group sender test");
        return;
    };
    let group = group(&pool, "stored-sender").await;
    let sent = store::send_message(
        &pool,
        &group.member,
        group.conversation_id,
        request(content(&envelope(
            &group,
            &group.member,
            json!({ "id": "s1", "senderAccountId": group.member, "text": "legacy",
                "createdAtMs": 1 }),
        ))),
    )
    .await
    .expect("member message");
    // Simulate a message stored before sender binding existed.
    let legacy = envelope(
        &group,
        &group.owner,
        json!({ "id": "s1", "senderAccountId": group.owner, "senderKind": "agent",
            "senderAgentId": format!("cloud-agent:{}", group.owner),
            "senderDisplayName": "Owner Kordi", "senderOwnerName": "Owner",
            "text": "legacy", "createdAtMs": 1 }),
    );
    query("UPDATE cloud_chat_messages SET content = $2 WHERE message_id = $1")
        .bind(sent.value.id)
        .bind(content(&legacy))
        .execute(&pool)
        .await
        .expect("store legacy envelope");
    let loaded = store::load_message_snapshot(&pool, sent.value.id)
        .await
        .expect("load legacy message");
    let message = stored_message(&loaded);
    assert_eq!(message["senderAccountId"], group.member.as_str());
    assert_eq!(message["senderKind"], "human");
    assert_eq!(message["senderDisplayName"], "stored-sender-member");
    assert!(message.get("senderAgentId").is_none());
    assert!(message.get("senderOwnerName").is_none());
}
